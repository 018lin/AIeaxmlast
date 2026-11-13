const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const sharp = require("sharp");
const XLSX = require("xlsx");
const { isObjectiveQuestion, validateDeskQuestions, validateWholePaperResult } = require("./lib/ai-grader");
const { analyzeAnswerLayout, analyzeContentBounds, alignBoxes } = require("./lib/answer-layout");
const { buildRegionsFromBoxes, frameFromBounds, preflightPage } = require("./lib/preflight");

const MASTERY_MASTERED = 0.85;
const MASTERY_DEVELOPING = 0.45;

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

function normalizeKnowledgePoints(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[，,\n]/);

  return Array.from(
    new Set(
      raw
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeQuestionNo(value) {
  return String(value || "")
    .trim()
    .replace(/^第\s*/, "")
    .replace(/\s*题$/, "")
    .replace(/[.。:：]$/, "")
    .trim();
}

function isWholePageCrop(value) {
  const box = value && typeof value === "object" ? value : {};
  return Number(box.width) === 1 && Number(box.height) === 1;
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
  let whereClause = "WHERE NOT desk_private";

  if (kind) {
    values.push(kind);
    whereClause += " AND kind = $1";
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
    await getPool().query("DELETE FROM uploaded_images WHERE NOT desk_private");
    return;
  }

  await getPool().query("DELETE FROM uploaded_images WHERE kind = $1 AND NOT desk_private", [kind]);
}

async function rejectDeskImageReferences(client, ids) {
  const references = ids.filter(Boolean);
  if (!references.length) return;
  const privateImages = await client.query("SELECT id FROM uploaded_images WHERE id = ANY($1::uuid[]) AND desk_private", [references]);
  if (privateImages.rowCount) throw forbiddenError("批改台照片不能用于旧版接口。");
}

async function createPair(payload) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await rejectDeskImageReferences(client, [payload.paperImageId, payload.answerImageId]);

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

async function createAiGradingHistory(payload, account) {
  const client = await getPool().connect();
  const result = payload.result && typeof payload.result === "object" ? payload.result : {};

  try {
    await client.query("BEGIN");
    await rejectDeskImageReferences(client, [payload.questionImageId, payload.answerImageId]);

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
          ai_result,
          teacher_account
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
          $15::jsonb,
          $16
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
        account || "",
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

async function listAiGradingHistory(account) {
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
    WHERE h.teacher_account = $1
    ORDER BY h.created_at DESC
    LIMIT 100
  `, [account || ""]);

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

async function deleteAiGradingHistory(account) {
  await getPool().query("DELETE FROM ai_grading_history WHERE teacher_account = $1", [account || ""]);
}

function mapClass(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade,
    createdAt: row.created_at,
  };
}

function mapStudent(row) {
  return {
    id: row.id,
    classId: row.class_id,
    className: row.class_name || "",
    name: row.name,
    studentNo: row.student_no,
    createdAt: row.created_at,
  };
}

function mapExam(row) {
  return {
    id: row.id,
    classId: row.class_id,
    className: row.class_name || "",
    name: row.name,
    subject: row.subject,
    examDate: row.exam_date,
    totalScore: Number(row.total_score || 0),
    questionCount: Number(row.question_count || 0),
    knowledgePoints: asJsonArray(row.knowledge_points),
    createdAt: row.created_at,
  };
}

function mapQuestion(row) {
  return {
    id: row.id,
    examId: row.exam_id,
    questionNo: row.question_no,
    title: row.title,
    maxScore: Number(row.max_score || 0),
    rubric: row.rubric,
    knowledgePoints: asJsonArray(row.knowledge_points),
    questionType: row.question_type || "",
    createdAt: row.created_at,
  };
}

function mapTemplate(row) {
  return {
    id: row.id,
    examId: row.exam_id,
    imageId: row.image_id,
    name: row.name,
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    image: row.image_base64 ? `data:${row.mime_type};base64,${row.image_base64}` : "",
    createdAt: row.created_at,
  };
}

function mapTemplateRegion(row) {
  return {
    id: row.id,
    templateId: row.template_id,
    questionId: row.question_id,
    questionNo: row.question_no,
    questionTitle: row.question_title || "",
    maxScore: row.max_score === null ? null : Number(row.max_score),
    xRatio: Number(row.x_ratio),
    yRatio: Number(row.y_ratio),
    widthRatio: Number(row.width_ratio),
    heightRatio: Number(row.height_ratio),
    createdAt: row.created_at,
  };
}

function mapBatch(row) {
  return {
    id: row.id,
    examId: row.exam_id,
    examName: row.exam_name || "",
    name: row.name,
    status: row.status,
    pageCount: Number(row.page_count || 0),
    jobCount: Number(row.job_count || 0),
    doneCount: Number(row.done_count || 0),
    failedCount: Number(row.failed_count || 0),
    createdAt: row.created_at,
  };
}

function bufferToDataUrl(mimeType, buffer) {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
}

function getSafeRatio(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, numeric));
}

async function createClass(payload, account) {
  const name = String(payload.name || "").trim();

  if (!name) {
    throw new Error("班级名称不能为空。");
  }

  const result = await getPool().query(
    `
      INSERT INTO classes (id, name, grade, teacher_account)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, grade, created_at
    `,
    [randomUUID(), name, String(payload.grade || "").trim(), String(account || "").trim()]
  );

  return mapClass(result.rows[0]);
}

async function listClasses(account) {
  const result = await getPool().query(
    `
      SELECT id, name, grade, created_at
      FROM classes
      WHERE teacher_account = $1
      ORDER BY created_at DESC
      LIMIT 200
    `,
    [String(account || "").trim()]
  );

  return result.rows.map(mapClass);
}

async function createStudent(payload, account) {
  const name = String(payload.name || "").trim();

  if (!name) {
    throw new Error("学生姓名不能为空。");
  }

  if (payload.classId) {
    await assertClassOwnership(payload.classId, account);
  }

  const result = await getPool().query(
    `
      INSERT INTO students (id, class_id, name, student_no, teacher_account)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, class_id, name, student_no, created_at
    `,
    [
      randomUUID(),
      payload.classId || null,
      name,
      String(payload.studentNo || "").trim(),
      String(account || "").trim(),
    ]
  );

  return mapStudent(result.rows[0]);
}

async function listStudents(classId, account) {
  const values = [];
  const conditions = [];

  if (account) {
    values.push(String(account).trim());
    conditions.push(`s.teacher_account = $${values.length}`);
  }

  if (classId) {
    values.push(classId);
    conditions.push(`s.class_id = $${values.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await getPool().query(
    `
      SELECT s.id, s.class_id, c.name AS class_name, s.name, s.student_no, s.created_at
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      ${whereClause}
      ORDER BY s.student_no ASC NULLS LAST, s.name ASC, s.created_at ASC
      LIMIT 1000
    `,
    values
  );

  return result.rows.map(mapStudent);
}

async function createExam(payload, account) {
  const name = String(payload.name || "").trim();

  if (!name) {
    throw new Error("考试名称不能为空。");
  }

  if (payload.classId) {
    await assertClassOwnership(payload.classId, account);
  }

  const knowledgePoints = normalizeKnowledgePoints(payload.knowledgePoints);
  const result = await getPool().query(
    `
      INSERT INTO exams (id, class_id, name, subject, exam_date, total_score, knowledge_points, teacher_account)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING id, class_id, name, subject, exam_date, total_score, knowledge_points, created_at
    `,
    [
      randomUUID(),
      payload.classId || null,
      name,
      String(payload.subject || "").trim(),
      payload.examDate || null,
      getNumericValue(payload.totalScore) || 0,
      JSON.stringify(knowledgePoints),
      String(account || "").trim(),
    ]
  );

  return mapExam(result.rows[0]);
}

async function listExams(account) {
  const result = await getPool().query(
    `
      SELECT
        e.id,
        e.class_id,
        c.name AS class_name,
        e.name,
        e.subject,
        e.exam_date,
        e.total_score,
        e.knowledge_points,
        e.created_at,
        COUNT(q.id) AS question_count
      FROM exams e
      LEFT JOIN classes c ON c.id = e.class_id
      LEFT JOIN exam_questions q ON q.exam_id = e.id
      WHERE e.teacher_account = $1
      GROUP BY e.id, c.name
      ORDER BY e.created_at DESC
      LIMIT 200
    `,
    [String(account || "").trim()]
  );

  return result.rows.map(mapExam);
}

async function listExamProgress(account) {
  const result = await getPool().query(
    `
      SELECT
        e.id AS exam_id,
        COALESCE(class_stats.student_count, 0) AS student_count,
        COALESCE(page_stats.submitted_count, 0) AS submitted_count,
        COALESCE(result_stats.graded_student_count, 0) AS graded_student_count
      FROM exams e
      LEFT JOIN (
        SELECT class_id, COUNT(*)::int AS student_count
        FROM students
        GROUP BY class_id
      ) class_stats ON class_stats.class_id = e.class_id
      LEFT JOIN LATERAL (
        SELECT b.id
        FROM scan_batches b
        WHERE b.exam_id = e.id
        ORDER BY b.created_at DESC
        LIMIT 1
      ) latest_batch ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT p.student_id)::int AS submitted_count
        FROM scanned_pages p
        WHERE p.batch_id = latest_batch.id
      ) page_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS graded_student_count
        FROM (
          SELECT r.student_id
          FROM grading_results r
          WHERE r.batch_id = latest_batch.id
          GROUP BY r.student_id
          HAVING COUNT(*) >= GREATEST((
            SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id
          ), 1)
        ) fully_graded
      ) result_stats ON TRUE
      WHERE e.teacher_account = $1
    `,
    [String(account || "").trim()]
  );

  return result.rows.map((row) => ({
    examId: row.exam_id,
    studentCount: Number(row.student_count || 0),
    submittedCount: Number(row.submitted_count || 0),
    gradedStudentCount: Number(row.graded_student_count || 0),
  }));
}

async function createExamQuestion(payload) {
  const examId = payload.examId || "";
  const questionNo = String(payload.questionNo || "").trim();
  const maxScore = Number(payload.maxScore);

  if (!examId) {
    throw new Error("请选择考试。");
  }

  if (!questionNo) {
    throw new Error("题号不能为空。");
  }

  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    throw new Error("题目满分必须大于 0。");
  }

  const knowledgePoints = String(payload.knowledgePoints || "")
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const result = await getPool().query(
    `
      INSERT INTO exam_questions (
        id, exam_id, question_no, title, max_score, rubric, knowledge_points, question_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING id, exam_id, question_no, title, max_score, rubric, knowledge_points, question_type, created_at
    `,
    [
      randomUUID(),
      examId,
      questionNo,
      String(payload.title || "").trim(),
      maxScore,
      String(payload.rubric || "").trim(),
      JSON.stringify(knowledgePoints),
      String(payload.questionType || "").trim(),
    ]
  );

  await refreshExamTotalScore(examId);
  return mapQuestion(result.rows[0]);
}

async function refreshExamTotalScore(examId) {
  await getPool().query(
    `
      UPDATE exams
      SET total_score = COALESCE((
        SELECT SUM(max_score)
        FROM exam_questions
        WHERE exam_id = $1
      ), 0)
      WHERE id = $1
    `,
    [examId]
  );
}

async function listExamQuestions(examId) {
  if (!examId) {
    return [];
  }

  const result = await getPool().query(
    `
      SELECT id, exam_id, question_no, title, max_score, rubric, knowledge_points, question_type, created_at
      FROM exam_questions
      WHERE exam_id = $1
      ORDER BY created_at ASC
    `,
    [examId]
  );

  return result.rows.map(mapQuestion);
}

async function createPaperTemplate(payload) {
  if (!payload.examId) {
    throw new Error("请选择考试。");
  }

  if (!payload.image) {
    throw new Error("请上传模板图片。");
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const imageId = await createImageUpload(client, {
      kind: "template_page",
      name: payload.name || "试卷模板",
      image: payload.image,
    });
    const result = await client.query(
      `
        INSERT INTO paper_templates (id, exam_id, image_id, name, width, height)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, exam_id, image_id, name, width, height, created_at
      `,
      [
        randomUUID(),
        payload.examId,
        imageId,
        String(payload.name || "试卷模板").trim(),
        Number(payload.width) || 0,
        Number(payload.height) || 0,
      ]
    );

    await client.query("COMMIT");
    return mapTemplate(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listPaperTemplates(examId) {
  if (!examId) {
    return [];
  }

  const result = await getPool().query(
    `
      SELECT
        t.id,
        t.exam_id,
        t.image_id,
        t.name,
        t.width,
        t.height,
        t.created_at,
        ui.mime_type,
        encode(ui.image_data, 'base64') AS image_base64
      FROM paper_templates t
      LEFT JOIN uploaded_images ui ON ui.id = t.image_id
      WHERE t.exam_id = $1
      ORDER BY t.created_at DESC
      LIMIT 20
    `,
    [examId]
  );

  return result.rows.map(mapTemplate);
}

async function saveTemplateRegion(payload) {
  const selection = payload.selection || {};
  const values = [
    randomUUID(),
    payload.templateId,
    payload.questionId,
    getSafeRatio(selection.xRatio ?? payload.xRatio),
    getSafeRatio(selection.yRatio ?? payload.yRatio),
    getSafeRatio(selection.widthRatio ?? payload.widthRatio),
    getSafeRatio(selection.heightRatio ?? payload.heightRatio),
  ];

  if (!payload.templateId || !payload.questionId) {
    throw new Error("请选择模板和题目。");
  }

  if (values[5] <= 0 || values[6] <= 0) {
    throw new Error("模板区域无效。");
  }

  const result = await getPool().query(
    `
      INSERT INTO template_regions (id, template_id, question_id, x_ratio, y_ratio, width_ratio, height_ratio)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (template_id, question_id)
      DO UPDATE SET
        x_ratio = EXCLUDED.x_ratio,
        y_ratio = EXCLUDED.y_ratio,
        width_ratio = EXCLUDED.width_ratio,
        height_ratio = EXCLUDED.height_ratio
      RETURNING id, template_id, question_id, x_ratio, y_ratio, width_ratio, height_ratio, created_at
    `,
    values
  );

  return mapTemplateRegion(result.rows[0]);
}

async function listTemplateRegions(templateId) {
  if (!templateId) {
    return [];
  }

  const result = await getPool().query(
    `
      SELECT
        r.id,
        r.template_id,
        r.question_id,
        r.x_ratio,
        r.y_ratio,
        r.width_ratio,
        r.height_ratio,
        r.created_at,
        q.question_no,
        q.title AS question_title,
        q.max_score
      FROM template_regions r
      JOIN exam_questions q ON q.id = r.question_id
      WHERE r.template_id = $1
      ORDER BY q.created_at ASC
    `,
    [templateId]
  );

  return result.rows.map(mapTemplateRegion);
}

async function createScanBatch(payload) {
  if (!payload.examId) {
    throw new Error("请选择考试。");
  }

  const name = String(payload.name || "").trim() || "未命名批次";
  const result = await getPool().query(
    `
      INSERT INTO scan_batches (id, exam_id, name, status)
      VALUES ($1, $2, $3, 'draft')
      RETURNING id, exam_id, name, status, created_at
    `,
    [randomUUID(), payload.examId, name]
  );

  return mapBatch(result.rows[0]);
}

async function listScanBatches(examId, account) {
  const values = [];
  const conditions = [];

  if (account) {
    values.push(String(account).trim());
    conditions.push(`e.teacher_account = $${values.length}`);
  }

  if (examId) {
    values.push(examId);
    conditions.push(`b.exam_id = $${values.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await getPool().query(
    `
      SELECT
        b.id,
        b.exam_id,
        e.name AS exam_name,
        b.name,
        b.status,
        b.created_at,
        COUNT(DISTINCT p.id) AS page_count,
        COUNT(DISTINCT j.id) AS job_count,
        COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'done') AS done_count,
        COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'failed') AS failed_count
      FROM scan_batches b
      JOIN exams e ON e.id = b.exam_id
      LEFT JOIN scanned_pages p ON p.batch_id = b.id
      LEFT JOIN grading_jobs j ON j.batch_id = b.id
      ${whereClause}
      GROUP BY b.id, e.name
      ORDER BY b.created_at DESC
      LIMIT 100
    `,
    values
  );

  return result.rows.map(mapBatch);
}

async function createScannedPage(payload) {
  if (!payload.batchId) {
    throw new Error("请选择批次。");
  }

  if (!payload.studentId) {
    throw new Error("请先绑定学生。");
  }

  if (!payload.image) {
    throw new Error("请上传扫描答卷图片。");
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const imageId = await createImageUpload(client, {
      kind: "scanned_page",
      name: payload.name || "扫描答卷",
      image: payload.image,
    });
    const result = await client.query(
      `
        INSERT INTO scanned_pages (id, batch_id, student_id, image_id, original_name, page_no)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, batch_id, student_id, image_id, original_name, page_no, created_at
      `,
      [
        randomUUID(),
        payload.batchId,
        payload.studentId,
        imageId,
        String(payload.name || "扫描答卷").trim(),
        Number(payload.pageNo) || 1,
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

async function listScannedPages(batchId) {
  if (!batchId) {
    return [];
  }

  const result = await getPool().query(
    `
      SELECT
        p.id,
        p.batch_id,
        p.student_id,
        s.name AS student_name,
        s.student_no,
        p.original_name,
        p.page_no,
        p.created_at
      FROM scanned_pages p
      LEFT JOIN students s ON s.id = p.student_id
      WHERE p.batch_id = $1
      ORDER BY p.created_at ASC
    `,
    [batchId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    studentId: row.student_id,
    studentName: row.student_name || "",
    studentNo: row.student_no || "",
    originalName: row.original_name,
    pageNo: row.page_no,
    createdAt: row.created_at,
  }));
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).replace(/\u00a0/g, " ").trim();
}

function normalizeHeader(value) {
  return normalizeCell(value).toLowerCase().replace(/\s+/g, "");
}

const STUDENT_NAME_HEADERS = ["姓名", "学生姓名", "学生名字", "名字", "学生", "name", "studentname", "student"];
const STUDENT_NO_HEADERS = ["学号", "学生学号", "编号", "序号", "学籍号", "studentno", "studentid", "no", "id"];

function findHeaderIndex(headers, candidates) {
  return headers.findIndex((header) => candidates.includes(header));
}

function parseImportDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]*)(;base64)?,(.*)$/s);

  if (!match) {
    throw new Error("请上传 Excel 文件。");
  }

  const mimeType = match[1] || "application/octet-stream";
  const buffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");

  if (!buffer.length) {
    throw new Error("Excel 文件内容为空。");
  }

  return { mimeType, buffer };
}

function parseStudentRowsFromWorkbook(buffer, mimeType) {
  const isCsv = mimeType.includes("csv");
  const workbook = isCsv
    ? XLSX.read(buffer.toString("utf8"), { type: "string" })
    : XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error("Excel 文件中没有可读取的工作表。");
  }

  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: "",
  });
  const rows = matrix
    .map((row) => (Array.isArray(row) ? row.map(normalizeCell) : []))
    .filter((row) => row.some(Boolean));

  if (!rows.length) {
    throw new Error("Excel 文件中没有学生数据。");
  }

  let headerRowIndex = -1;
  let nameIndex = 0;
  let noIndex = -1;

  for (let index = 0; index < Math.min(rows.length, 8); index += 1) {
    const headers = rows[index].map(normalizeHeader);
    const candidateNameIndex = findHeaderIndex(headers, STUDENT_NAME_HEADERS);

    if (candidateNameIndex !== -1) {
      headerRowIndex = index;
      nameIndex = candidateNameIndex;
      noIndex = findHeaderIndex(headers, STUDENT_NO_HEADERS);
      break;
    }
  }

  if (headerRowIndex === -1) {
    const firstRowHeaders = rows[0].map(normalizeHeader);
    headerRowIndex = findHeaderIndex(firstRowHeaders, STUDENT_NAME_HEADERS) !== -1 ? 0 : -1;
    noIndex = 1;
  }

  const dataRows = rows.slice(headerRowIndex + 1);
  const students = [];
  const seen = new Set();

  dataRows.forEach((row) => {
    const name = normalizeCell(row[nameIndex]);
    const studentNo = noIndex >= 0 ? normalizeCell(row[noIndex]) : "";

    if (!name || name.length > 40 || STUDENT_NAME_HEADERS.includes(normalizeHeader(name))) {
      return;
    }

    const key = `${name}|${studentNo}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    students.push({ name, studentNo });
  });

  if (!students.length) {
    throw new Error("没有识别到学生姓名，请确认表头包含“姓名”列。");
  }

  return students;
}

function forbiddenError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

async function assertClassOwnership(classId, account) {
  if (!classId) {
    return;
  }

  const result = await getPool().query(
    "SELECT 1 FROM classes WHERE id = $1 AND teacher_account = $2",
    [classId, String(account || "").trim()]
  );

  if (!result.rowCount) {
    throw forbiddenError("班级不存在或无权访问。");
  }
}

async function assertStudentOwnership(studentId, account) {
  if (!studentId) {
    return;
  }

  const result = await getPool().query(
    "SELECT 1 FROM students WHERE id = $1 AND teacher_account = $2",
    [studentId, String(account || "").trim()]
  );

  if (!result.rowCount) {
    throw forbiddenError("学生不存在或无权访问。");
  }
}

async function assertExamOwnership(examId, account) {
  if (!examId) {
    return;
  }

  const result = await getPool().query(
    "SELECT 1 FROM exams WHERE id = $1 AND teacher_account = $2",
    [examId, String(account || "").trim()]
  );

  if (!result.rowCount) {
    throw forbiddenError("作业不存在或无权访问。");
  }
}

async function assertBatchOwnership(batchId, account) {
  if (!batchId) {
    return;
  }

  const result = await getPool().query(
    `
      SELECT 1
      FROM scan_batches b
      JOIN exams e ON e.id = b.exam_id
      WHERE b.id = $1 AND e.teacher_account = $2
    `,
    [batchId, String(account || "").trim()]
  );

  if (!result.rowCount) {
    throw forbiddenError("批次不存在或无权访问。");
  }
}

async function assertTemplateOwnership(templateId, account) {
  if (!templateId) {
    return;
  }

  const result = await getPool().query(
    `
      SELECT 1
      FROM paper_templates t
      JOIN exams e ON e.id = t.exam_id
      WHERE t.id = $1 AND e.teacher_account = $2
    `,
    [templateId, String(account || "").trim()]
  );

  if (!result.rowCount) {
    throw forbiddenError("模板不存在或无权访问。");
  }
}

async function assertQuestionOwnership(questionId, account) {
  if (!questionId) {
    return;
  }

  const result = await getPool().query(
    `
      SELECT 1
      FROM exam_questions q
      JOIN exams e ON e.id = q.exam_id
      WHERE q.id = $1 AND e.teacher_account = $2
    `,
    [questionId, String(account || "").trim()]
  );

  if (!result.rowCount) {
    throw forbiddenError("题目不存在或无权访问。");
  }
}

async function getClassRecord(classId, account) {
  const values = [classId];
  let whereClause = "id = $1";

  if (account) {
    values.push(String(account).trim());
    whereClause += " AND teacher_account = $2";
  }

  const result = await getPool().query(
    `SELECT id, name, grade, created_at FROM classes WHERE ${whereClause}`,
    values
  );

  if (result.rowCount === 0) {
    throw forbiddenError(account ? "班级不存在或无权访问。" : "班级不存在。");
  }

  return mapClass(result.rows[0]);
}

async function getExamRecord(examId, account) {
  const values = [examId];
  let whereClause = "e.id = $1";

  if (account) {
    values.push(String(account).trim());
    whereClause += " AND e.teacher_account = $2";
  }

  const result = await getPool().query(
    `
      SELECT
        e.id,
        e.class_id,
        c.name AS class_name,
        e.name,
        e.subject,
        e.exam_date,
        e.total_score,
        e.knowledge_points,
        e.created_at,
        COUNT(q.id) AS question_count
      FROM exams e
      LEFT JOIN classes c ON c.id = e.class_id
      LEFT JOIN exam_questions q ON q.exam_id = e.id
      WHERE ${whereClause}
      GROUP BY e.id, c.name
    `,
    values
  );

  if (result.rowCount === 0) {
    throw forbiddenError(account ? "作业不存在或无权访问。" : "作业不存在。");
  }

  return mapExam(result.rows[0]);
}

async function importStudents(payload, account) {
  const file = payload.file || payload.excel || "";

  if (!file) {
    throw new Error("请上传包含学生名单的 Excel 文件。");
  }

  let classItem;

  if (payload.classId) {
    classItem = await getClassRecord(payload.classId, account);
  } else {
    const className = String(payload.className || "").trim();

    if (!className) {
      throw new Error("请选择已有班级，或填写新班级名称。");
    }

    classItem = await createClass({ name: className, grade: payload.grade }, account);
  }

  const { mimeType, buffer } = parseImportDataUrl(file);

  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error("Excel 文件过大，请控制在 8MB 以内。");
  }

  const rows = parseStudentRowsFromWorkbook(buffer, mimeType);
  const existingResult = await getPool().query(
    "SELECT name, student_no FROM students WHERE class_id = $1",
    [classItem.id]
  );
  const existingKeys = new Set(
    existingResult.rows.map((row) => `${normalizeCell(row.name)}|${normalizeCell(row.student_no)}`)
  );
  const client = await getPool().connect();
  let created = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const row of rows) {
      const key = `${row.name}|${row.studentNo}`;

      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }

      await client.query(
        `
          INSERT INTO students (id, class_id, name, student_no, teacher_account)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [randomUUID(), classItem.id, row.name, row.studentNo, String(account || "").trim()]
      );
      existingKeys.add(key);
      created += 1;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    classItem,
    created,
    skipped,
    total: rows.length,
    students: await listStudents(classItem.id, account),
  };
}

function classifyMastery(rate) {
  if (!Number.isFinite(rate)) {
    return { code: "none", label: "暂无数据" };
  }

  if (rate >= MASTERY_MASTERED) {
    return { code: "mastered", label: "完全掌握" };
  }

  if (rate >= MASTERY_DEVELOPING) {
    return { code: "developing", label: "尚未熟练掌握" };
  }

  return { code: "weak", label: "完全不会" };
}

function roundRate(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function toBucketItem(stats, classification) {
  return {
    name: stats.name,
    attempts: stats.attempts,
    questionCount: stats.questionIds ? stats.questionIds.size : stats.attempts,
    achieved: Math.round(stats.achieved * 100) / 100,
    max: Math.round(stats.max * 100) / 100,
    rate: roundRate(stats.max > 0 ? stats.achieved / stats.max : 0),
    wrongCount: stats.wrongCount || 0,
    zeroCount: stats.zeroCount || 0,
    classification,
  };
}

function buildTagStats(rows, getTags) {
  const statsMap = new Map();

  rows.forEach((row) => {
    const score = Number(row.score);
    const maxScore = Number(row.max_score);

    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
      return;
    }

    const tags = getTags(row).filter(Boolean);
    const isWrong = score < maxScore - 0.001;

    tags.forEach((tag) => {
      const stats = statsMap.get(tag) || {
        name: tag,
        attempts: 0,
        achieved: 0,
        max: 0,
        wrongCount: 0,
        zeroCount: 0,
        questionIds: new Set(),
      };

      stats.attempts += 1;
      stats.achieved += score;
      stats.max += maxScore;
      stats.wrongCount += isWrong ? 1 : 0;
      stats.zeroCount += score <= 0.001 ? 1 : 0;
      stats.questionIds.add(row.question_id);
      statsMap.set(tag, stats);
    });
  });

  return Array.from(statsMap.values())
    .map((stats) => {
      const rate = stats.max > 0 ? stats.achieved / stats.max : 0;
      const classification = classifyMastery(rate).code;

      return toBucketItem(stats, classification);
    })
    .sort((left, right) => left.rate - right.rate || right.attempts - left.attempts);
}

async function getLatestExamBatch(examId) {
  const result = await getPool().query(
    `
      SELECT
        b.id,
        b.exam_id,
        e.name AS exam_name,
        b.name,
        b.status,
        b.created_at
      FROM scan_batches b
      JOIN exams e ON e.id = b.exam_id
      WHERE b.exam_id = $1
      ORDER BY b.created_at DESC
      LIMIT 1
    `,
    [examId]
  );

  return result.rowCount ? mapBatch(result.rows[0]) : null;
}

async function getOrCreateExamBatch(examId) {
  const exam = await getExamRecord(examId);
  const existing = await getLatestExamBatch(examId);

  if (existing) {
    return existing;
  }

  const result = await getPool().query(
    `
      INSERT INTO scan_batches (id, exam_id, name, status)
      VALUES ($1, $2, $3, 'draft')
      RETURNING id, exam_id, name, status, created_at
    `,
    [randomUUID(), examId, `${exam.name} 作业批次`]
  );

  return {
    ...mapBatch(result.rows[0]),
    examName: exam.name,
  };
}

async function getAssignmentOverview(examId) {
  const exam = await getExamRecord(examId);
  const batch = await getLatestExamBatch(examId);
  const students = exam.classId ? await listStudents(exam.classId) : [];
  const studentMap = new Map(
    students.map((student) => [
      student.id,
      {
        ...student,
        pageCount: 0,
        resultCount: 0,
        totalScore: 0,
        maxScore: exam.totalScore,
        wrongCount: 0,
        pendingCount: 0,
        failedCount: 0,
        status: "not_submitted",
      },
    ])
  );

  if (batch) {
    const [pageResult, resultResult, jobResult] = await Promise.all([
      getPool().query(
        `
          SELECT student_id, COUNT(*) AS page_count
          FROM scanned_pages
          WHERE batch_id = $1
          GROUP BY student_id
        `,
        [batch.id]
      ),
      getPool().query(
        `
          SELECT
            student_id,
            COUNT(*) AS result_count,
            COALESCE(SUM(score), 0) AS total_score,
            COUNT(*) FILTER (WHERE score IS NOT NULL AND score < max_score - 0.001) AS wrong_count
          FROM grading_results
          WHERE batch_id = $1
          GROUP BY student_id
        `,
        [batch.id]
      ),
      getPool().query(
        `
          SELECT
            ac.student_id,
            COUNT(*) FILTER (WHERE j.status IN ('pending', 'running')) AS pending_count,
            COUNT(*) FILTER (WHERE j.status = 'failed') AS failed_count
          FROM grading_jobs j
          JOIN answer_crops ac ON ac.id = j.answer_crop_id
          WHERE j.batch_id = $1
          GROUP BY ac.student_id
        `,
        [batch.id]
      ),
    ]);

    pageResult.rows.forEach((row) => {
      const student = studentMap.get(row.student_id);
      if (student) {
        student.pageCount = Number(row.page_count || 0);
      }
    });

    resultResult.rows.forEach((row) => {
      const student = studentMap.get(row.student_id);
      if (student) {
        student.resultCount = Number(row.result_count || 0);
        student.totalScore = Number(row.total_score || 0);
        student.wrongCount = Number(row.wrong_count || 0);
      }
    });

    jobResult.rows.forEach((row) => {
      const student = studentMap.get(row.student_id);
      if (student) {
        student.pendingCount = Number(row.pending_count || 0);
        student.failedCount = Number(row.failed_count || 0);
      }
    });
  }

  const studentList = Array.from(studentMap.values()).map((student) => {
    let status = "not_submitted";

    if (student.pageCount > 0) {
      if (exam.questionCount > 0 && student.resultCount >= exam.questionCount) {
        status = "graded";
      } else if (student.failedCount > 0 && student.pendingCount === 0) {
        status = "needs_review";
      } else if (student.resultCount > 0 || student.pendingCount > 0) {
        status = "grading";
      } else {
        status = "submitted";
      }
    }

    return {
      ...student,
      totalScore: Math.round(student.totalScore * 100) / 100,
      status,
    };
  });
  const submittedCount = studentList.filter((student) => student.pageCount > 0).length;
  const gradedCount = studentList.filter((student) => student.status === "graded").length;
  const totalAchieved = studentList.reduce((sum, student) => sum + student.totalScore, 0);

  return {
    exam,
    batch,
    summary: {
      studentCount: studentList.length,
      submittedCount,
      gradedCount,
      totalAchieved: Math.round(totalAchieved * 100) / 100,
      questionCount: exam.questionCount,
      maxScore: exam.totalScore,
    },
    students: studentList,
  };
}

async function replaceStudentSubmission(batchId, studentId, payload) {
  const batchResult = await getPool().query(
    `
      SELECT b.id, b.exam_id
      FROM scan_batches b
      WHERE b.id = $1
    `,
    [batchId]
  );

  if (batchResult.rowCount === 0) {
    throw new Error("作业批次不存在。");
  }

  const exam = await getExamRecord(batchResult.rows[0].exam_id);
  const studentResult = await getPool().query(
    "SELECT id, class_id, name FROM students WHERE id = $1",
    [studentId]
  );

  if (studentResult.rowCount === 0) {
    throw new Error("学生不存在。");
  }

  const student = studentResult.rows[0];

  if (exam.classId && student.class_id && exam.classId !== student.class_id) {
    throw new Error("该学生不属于当前作业所在班级。");
  }

  if (!payload.image) {
    throw new Error("请拍照或上传学生作业图片。");
  }

  await getPool().query(
    "DELETE FROM scanned_pages WHERE batch_id = $1 AND student_id = $2",
    [batchId, studentId]
  );

  return createScannedPage({
    batchId,
    studentId,
    name: payload.name || `${student.name}-作业`,
    image: payload.image,
    pageNo: 1,
  });
}

async function cropPageIntoJobs(client, batchId, page, regions) {
  const pageBuffer = Buffer.from(page.image_data);
  const metadata = await sharp(pageBuffer).metadata();
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);

  if (!sourceWidth || !sourceHeight) {
    throw new Error(`扫描答卷 ${page.original_name} 图片尺寸无效。`);
  }

  let createdCropCount = 0;

  for (const region of regions) {
    const left = Math.max(0, Math.round(Number(region.x_ratio) * sourceWidth));
    const top = Math.max(0, Math.round(Number(region.y_ratio) * sourceHeight));
    const desiredWidth = Math.max(1, Math.round(Number(region.width_ratio) * sourceWidth));
    const desiredHeight = Math.max(1, Math.round(Number(region.height_ratio) * sourceHeight));
    const width = Math.min(desiredWidth, sourceWidth - left);
    const height = Math.min(desiredHeight, sourceHeight - top);

    if (width <= 0 || height <= 0) {
      continue;
    }

    const cropBuffer = await sharp(pageBuffer)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    const uploadId = randomUUID();
    const cropId = randomUUID();
    const jobId = randomUUID();

    await client.query(
      `
        INSERT INTO uploaded_images (id, kind, original_name, mime_type, image_data)
        VALUES ($1, 'answer_crop', $2, 'image/png', $3)
      `,
      [uploadId, `${page.original_name}-${region.question_no}`, cropBuffer]
    );

    await client.query(
      `
        INSERT INTO answer_crops (
          id,
          batch_id,
          scanned_page_id,
          student_id,
          question_id,
          crop_image_id,
          crop_box
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        cropId,
        batchId,
        page.id,
        page.student_id,
        region.question_id,
        uploadId,
        JSON.stringify({ left, top, width, height }),
      ]
    );

    await client.query(
      `
        INSERT INTO grading_jobs (id, batch_id, answer_crop_id, status)
        VALUES ($1, $2, $3, 'pending')
      `,
      [jobId, batchId, cropId]
    );

    createdCropCount += 1;
  }

  return createdCropCount;
}

async function processStudentSubmission(batchId, studentId) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const batchResult = await client.query(
      "SELECT id, exam_id FROM scan_batches WHERE id = $1",
      [batchId]
    );

    if (batchResult.rowCount === 0) {
      throw new Error("作业批次不存在。");
    }

    const batch = batchResult.rows[0];
    const templateResult = await client.query(
      `
        SELECT t.id
        FROM paper_templates t
        WHERE t.exam_id = $1
        ORDER BY t.created_at DESC
        LIMIT 1
      `,
      [batch.exam_id]
    );

    if (templateResult.rowCount === 0) {
      throw new Error("当前作业还没有试卷模板，请先在作业设置中上传模板。");
    }

    const regionsResult = await client.query(
      `
        SELECT r.*, q.question_no
        FROM template_regions r
        JOIN exam_questions q ON q.id = r.question_id
        WHERE r.template_id = $1
        ORDER BY q.created_at ASC
      `,
      [templateResult.rows[0].id]
    );

    if (regionsResult.rowCount === 0) {
      throw new Error("当前模板还没有框选题目区域，请先在作业设置中完成框选。");
    }

    const pagesResult = await client.query(
      `
        SELECT
          p.id,
          p.student_id,
          p.original_name,
          ui.image_data
        FROM scanned_pages p
        JOIN uploaded_images ui ON ui.id = p.image_id
        WHERE p.batch_id = $1 AND p.student_id = $2
        ORDER BY p.created_at ASC
      `,
      [batchId, studentId]
    );

    if (pagesResult.rowCount === 0) {
      throw new Error("该学生还没有上传作业图片。");
    }

    await client.query(
      "DELETE FROM answer_crops WHERE batch_id = $1 AND student_id = $2",
      [batchId, studentId]
    );

    let cropCount = 0;

    for (const page of pagesResult.rows) {
      cropCount += await cropPageIntoJobs(client, batchId, page, regionsResult.rows);
    }

    await client.query("UPDATE scan_batches SET status = 'grading' WHERE id = $1", [batchId]);
    await client.query("COMMIT");

    return { batchId, studentId, cropCount, jobCount: cropCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function examHasTemplateRegions(examId) {
  const result = await getPool().query(
    `
      SELECT 1
      FROM paper_templates t
      JOIN template_regions r ON r.template_id = t.id
      WHERE t.exam_id = $1
      LIMIT 1
    `,
    [examId]
  );

  return result.rowCount > 0;
}

async function getExamKnowledgePoints(examId) {
  const exam = await getExamRecord(examId);
  const questions = await listExamQuestions(examId);
  const points = new Set(exam.knowledgePoints || []);

  questions.forEach((question) => {
    (question.knowledgePoints || []).forEach((point) => points.add(point));
  });

  return Array.from(points);
}

async function getStudentPageImage(batchId, studentId) {
  const result = await getPool().query(
    `
      SELECT ui.image_data
      FROM scanned_pages p
      JOIN uploaded_images ui ON ui.id = p.image_id
      WHERE p.batch_id = $1 AND p.student_id = $2
      ORDER BY p.created_at ASC
      LIMIT 1
    `,
    [batchId, studentId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const buffer = await sharp(Buffer.from(result.rows[0].image_data))
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  return { image: `data:image/jpeg;base64,${buffer.toString("base64")}` };
}

async function saveWholePaperResults(payload) {
  const questions = Array.isArray(payload.gradeResult?.questions) ? payload.gradeResult.questions : [];

  if (!questions.length) {
    throw new Error("AI 没有识别出可批改的题目，请换一张更清晰的作业图片。");
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const pageResult = await client.query(
      `
        SELECT id, image_id
        FROM scanned_pages
        WHERE batch_id = $1 AND student_id = $2
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [payload.batchId, payload.studentId]
    );

    if (pageResult.rowCount === 0) {
      throw new Error("该学生还没有上传作业图片。");
    }

    const page = pageResult.rows[0];
    const existingResult = await client.query(
      "SELECT id, question_no FROM exam_questions WHERE exam_id = $1",
      [payload.examId]
    );
    const questionMap = new Map(
      existingResult.rows.map((row) => [normalizeQuestionNo(row.question_no), row.id])
    );
    const seenQuestions = new Set();
    let count = 0;

    for (const item of questions) {
      const questionNo = normalizeQuestionNo(item.question_no ?? item.questionNo);

      if (!questionNo || seenQuestions.has(questionNo)) {
        continue;
      }

      seenQuestions.add(questionNo);

      const maxScore = Math.max(0.5, Math.min(Number(item.max_score ?? item.maxScore) || 10, 1000));
      const rawScore =
        item.score === null || item.score === undefined || item.score === ""
          ? NaN
          : Number(item.score);

      if (!Number.isFinite(rawScore)) {
        continue;
      }

      const score = Math.max(0, Math.min(rawScore, maxScore));
      const knowledgePoints = normalizeKnowledgePoints(item.knowledge_points ?? item.knowledgePoints);
      let questionId = questionMap.get(questionNo);

      if (!questionId) {
        questionId = randomUUID();
        await client.query(
          `
            INSERT INTO exam_questions (
              id, exam_id, question_no, title, max_score, rubric, knowledge_points, question_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          `,
          [
            questionId,
            payload.examId,
            questionNo,
            String(item.title || "").trim(),
            maxScore,
            "",
            JSON.stringify(knowledgePoints),
            String(item.question_type ?? item.questionType ?? "").trim(),
          ]
        );
        questionMap.set(questionNo, questionId);
      }

      const cropId = randomUUID();
      const jobId = randomUUID();
      await client.query(
        `
          INSERT INTO answer_crops (id, batch_id, scanned_page_id, student_id, question_id, crop_image_id, crop_box)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          cropId,
          payload.batchId,
          page.id,
          payload.studentId,
          questionId,
          page.image_id,
          JSON.stringify({ left: 0, top: 0, width: 1, height: 1 }),
        ]
      );
      await client.query(
        `
          INSERT INTO grading_jobs (id, batch_id, answer_crop_id, status, finished_at)
          VALUES ($1, $2, $3, 'done', now())
        `,
        [jobId, payload.batchId, cropId]
      );
      await client.query(
        `
          INSERT INTO grading_results (
            id, job_id, batch_id, exam_id, student_id, question_id, score, max_score,
            level, analysis, deductions, suggestions, raw_content, ai_result
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb)
        `,
        [
          randomUUID(),
          jobId,
          payload.batchId,
          payload.examId,
          payload.studentId,
          questionId,
          score,
          maxScore,
          String(item.level || "").trim(),
          String(item.analysis || "").trim(),
          JSON.stringify(asJsonArray(item.deductions)),
          JSON.stringify(asJsonArray(item.suggestions)),
          payload.rawContent || "",
          JSON.stringify(item),
        ]
      );
      count += 1;
    }

    if (!count) {
      throw new Error("AI 没有识别出可批改的题目，请换一张更清晰的作业图片。");
    }

    await client.query("UPDATE scan_batches SET status = 'done' WHERE id = $1", [payload.batchId]);
    await client.query("COMMIT");
    await refreshExamTotalScore(payload.examId);
    return { count };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getStudentGradingProgress(batchId, studentId) {
  const result = await getPool().query(
    `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE j.status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE j.status = 'running') AS running,
        COUNT(*) FILTER (WHERE j.status = 'done') AS done,
        COUNT(*) FILTER (WHERE j.status = 'failed') AS failed
      FROM grading_jobs j
      JOIN answer_crops ac ON ac.id = j.answer_crop_id
      WHERE j.batch_id = $1 AND ac.student_id = $2
    `,
    [batchId, studentId]
  );
  const row = result.rows[0] || {};

  return {
    total: Number(row.total || 0),
    pending: Number(row.pending || 0),
    running: Number(row.running || 0),
    done: Number(row.done || 0),
    failed: Number(row.failed || 0),
  };
}

async function getStudentSubmission(batchId, studentId, includeImages = false) {
  const studentResult = await getPool().query(
    `
      SELECT s.id, s.class_id, c.name AS class_name, s.name, s.student_no
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id = $1
    `,
    [studentId]
  );

  if (studentResult.rowCount === 0) {
    throw new Error("学生不存在。");
  }

  const batchResult = await getPool().query(
    `
      SELECT b.id, b.exam_id, b.name, b.status, e.name AS exam_name, e.total_score
      FROM scan_batches b
      JOIN exams e ON e.id = b.exam_id
      WHERE b.id = $1
    `,
    [batchId]
  );

  if (batchResult.rowCount === 0) {
    throw new Error("作业批次不存在。");
  }

  const [resultsResult, questionsResult, progress, pageResult] = await Promise.all([
    getPool().query(
      `
        SELECT
          gr.id,
          gr.question_id,
          q.question_no,
          q.title AS question_title,
          q.question_type,
          q.knowledge_points,
          gr.score,
          gr.max_score,
          gr.level,
          gr.analysis,
          gr.deductions,
          gr.suggestions,
          gr.created_at,
          ac.crop_box,
          ai.mime_type AS answer_mime_type,
          ai.image_data AS answer_image_data
        FROM grading_results gr
        JOIN exam_questions q ON q.id = gr.question_id
        JOIN grading_jobs j ON j.id = gr.job_id
        JOIN answer_crops ac ON ac.id = j.answer_crop_id
        LEFT JOIN uploaded_images ai
          ON ai.id = ac.crop_image_id
          AND NOT (
            COALESCE((ac.crop_box->>'width')::numeric, 0) = 1
            AND COALESCE((ac.crop_box->>'height')::numeric, 0) = 1
          )
        WHERE gr.batch_id = $1 AND gr.student_id = $2
        ORDER BY q.created_at ASC
      `,
      [batchId, studentId]
    ),
    getPool().query(
      `
        SELECT id, question_no, title, question_type, knowledge_points, max_score
        FROM exam_questions
        WHERE exam_id = $1
        ORDER BY created_at ASC
      `,
      [batchResult.rows[0].exam_id]
    ),
    getStudentGradingProgress(batchId, studentId),
    includeImages
      ? getPool().query(
          `
            SELECT ai.mime_type, ai.image_data
            FROM scanned_pages sp
            JOIN uploaded_images ai ON ai.id = sp.image_id
            WHERE sp.batch_id = $1 AND sp.student_id = $2
            ORDER BY sp.created_at DESC
            LIMIT 1
          `,
          [batchId, studentId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  let pageImage = "";

  if (includeImages && pageResult.rows[0]?.image_data) {
    try {
      const buffer = await sharp(Buffer.from(pageResult.rows[0].image_data))
        .resize({ width: 1000, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      pageImage = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch {
      pageImage = "";
    }
  }

  const results = [];

  for (const row of resultsResult.rows) {
    let answerImage = "";

    if (includeImages && row.answer_image_data && !isWholePageCrop(row.crop_box)) {
      try {
        const buffer = await sharp(Buffer.from(row.answer_image_data))
          .resize({ width: 560, withoutEnlargement: true })
          .jpeg({ quality: 72 })
          .toBuffer();
        answerImage = `data:image/jpeg;base64,${buffer.toString("base64")}`;
      } catch {
        answerImage = "";
      }
    }

    results.push({
      id: row.id,
      questionId: row.question_id,
      questionNo: row.question_no,
      questionTitle: row.question_title,
      questionType: row.question_type || "",
      knowledgePoints: asJsonArray(row.knowledge_points),
      score: row.score === null ? null : Number(row.score),
      maxScore: Number(row.max_score || 0),
      level: row.level,
      analysis: row.analysis,
      deductions: asJsonArray(row.deductions),
      suggestions: asJsonArray(row.suggestions),
      answerImage,
      createdAt: row.created_at,
    });
  }

  const answeredQuestionIds = new Set(results.map((item) => item.questionId));
  const missingQuestions = questionsResult.rows
    .filter((question) => !answeredQuestionIds.has(question.id))
    .map((question) => ({
      questionId: question.id,
      questionNo: question.question_no,
      questionTitle: question.title,
      questionType: question.question_type || "",
      knowledgePoints: asJsonArray(question.knowledge_points),
      maxScore: Number(question.max_score || 0),
    }));
  const totalScore = results.reduce((sum, item) => sum + (Number(item.score) || 0), 0);

  return {
    student: {
      id: studentResult.rows[0].id,
      classId: studentResult.rows[0].class_id,
      className: studentResult.rows[0].class_name || "",
      name: studentResult.rows[0].name,
      studentNo: studentResult.rows[0].student_no,
    },
    batch: {
      id: batchResult.rows[0].id,
      examId: batchResult.rows[0].exam_id,
      examName: batchResult.rows[0].exam_name,
      name: batchResult.rows[0].name,
      status: batchResult.rows[0].status,
    },
    progress,
    pageImage,
    totalScore: Math.round(totalScore * 100) / 100,
    maxScore: Number(batchResult.rows[0].total_score || 0),
    results,
    missingQuestions,
  };
}

async function getBatchAnalysis(batchId) {
  const batchResult = await getPool().query(
    `
      SELECT
        b.id,
        b.exam_id,
        b.name,
        b.status,
        b.created_at,
        e.name AS exam_name,
        e.subject,
        e.exam_date,
        e.total_score,
        e.class_id,
        c.name AS class_name
      FROM scan_batches b
      JOIN exams e ON e.id = b.exam_id
      LEFT JOIN classes c ON c.id = e.class_id
      WHERE b.id = $1
    `,
    [batchId]
  );

  if (batchResult.rowCount === 0) {
    throw new Error("作业批次不存在。");
  }

  const batch = batchResult.rows[0];
  const [questionsResult, studentsResult, resultsResult, analysisResult] = await Promise.all([
    getPool().query(
      `
        SELECT id, question_no, title, question_type, knowledge_points, max_score
        FROM exam_questions
        WHERE exam_id = $1
        ORDER BY created_at ASC
      `,
      [batch.exam_id]
    ),
    getPool().query(
      `
        SELECT DISTINCT s.id, s.name, s.student_no
        FROM scanned_pages p
        JOIN students s ON s.id = p.student_id
        WHERE p.batch_id = $1
        ORDER BY s.student_no ASC, s.name ASC
      `,
      [batchId]
    ),
    getPool().query(
      `
        SELECT
          gr.id,
          gr.student_id,
          s.name AS student_name,
          s.student_no,
          gr.question_id,
          q.question_no,
          q.title AS question_title,
          q.question_type,
          q.knowledge_points,
          q.max_score AS question_max_score,
          gr.score,
          gr.max_score,
          gr.level,
          gr.analysis,
          gr.deductions,
          gr.suggestions,
          gr.created_at
        FROM grading_results gr
        JOIN students s ON s.id = gr.student_id
        JOIN exam_questions q ON q.id = gr.question_id
        WHERE gr.batch_id = $1
        ORDER BY q.created_at ASC, s.student_no ASC, gr.created_at ASC
      `,
      [batchId]
    ),
    getPool().query(
      "SELECT summary, model, created_at FROM assignment_analyses WHERE batch_id = $1",
      [batchId]
    ),
  ]);

  const latestResultMap = new Map();

  resultsResult.rows.forEach((row) => {
    latestResultMap.set(`${row.student_id}|${row.question_id}`, row);
  });

  const results = Array.from(latestResultMap.values()).filter((row) => row.score !== null);
  const questions = questionsResult.rows.map((question) => {
    const questionResults = results.filter((row) => row.question_id === question.id);
    const maxScore = Number(question.max_score || 0);
    const wrongResults = questionResults.filter((row) => Number(row.score) < maxScore - 0.001);
    const achieved = questionResults.reduce((sum, row) => sum + Number(row.score || 0), 0);
    const maxTotal = questionResults.reduce((sum, row) => sum + Number(row.max_score || 0), 0);

    return {
      id: question.id,
      questionNo: question.question_no,
      questionTitle: question.title,
      questionType: question.question_type || "",
      knowledgePoints: asJsonArray(question.knowledge_points),
      maxScore,
      gradedCount: questionResults.length,
      correctCount: questionResults.filter((row) => Number(row.score) >= maxScore - 0.001).length,
      wrongCount: wrongResults.length,
      zeroCount: questionResults.filter((row) => Number(row.score) <= 0.001).length,
      avgScore: questionResults.length ? Math.round((achieved / questionResults.length) * 100) / 100 : 0,
      rate: roundRate(maxTotal > 0 ? achieved / maxTotal : 0),
      wrongStudents: wrongResults.map((row) => ({
        studentId: row.student_id,
        studentName: row.student_name,
        studentNo: row.student_no,
        score: Number(row.score),
        maxScore: Number(row.max_score || 0),
        analysis: row.analysis || "",
        deductions: asJsonArray(row.deductions),
      })),
    };
  });

  const knowledgeStatsMap = new Map();

  results.forEach((row) => {
    const score = Number(row.score);
    const maxScore = Number(row.max_score);
    const isWrong = score < maxScore - 0.001;

    asJsonArray(row.knowledge_points).forEach((knowledgePoint) => {
      const stats = knowledgeStatsMap.get(knowledgePoint) || {
        name: knowledgePoint,
        attempts: 0,
        achieved: 0,
        max: 0,
        wrongCount: 0,
        zeroCount: 0,
        questionIds: new Set(),
        wrongStudentMap: new Map(),
      };

      stats.attempts += 1;
      stats.achieved += score;
      stats.max += maxScore;
      stats.wrongCount += isWrong ? 1 : 0;
      stats.zeroCount += score <= 0.001 ? 1 : 0;
      stats.questionIds.add(row.question_id);

      if (isWrong) {
        stats.wrongStudentMap.set(row.student_id, row.student_name);
      }

      knowledgeStatsMap.set(knowledgePoint, stats);
    });
  });

  const knowledgePoints = Array.from(knowledgeStatsMap.values())
    .map((stats) => {
      const rate = stats.max > 0 ? stats.achieved / stats.max : 0;
      const classification = classifyMastery(rate);

      return {
        name: stats.name,
        attempts: stats.attempts,
        questionCount: stats.questionIds.size,
        achieved: Math.round(stats.achieved * 100) / 100,
        max: Math.round(stats.max * 100) / 100,
        rate: roundRate(rate),
        wrongCount: stats.wrongCount,
        zeroCount: stats.zeroCount,
        classification: classification.code,
        label: classification.label,
        wrongStudents: Array.from(stats.wrongStudentMap.values()),
      };
    })
    .sort((left, right) => left.rate - right.rate || right.wrongCount - left.wrongCount);

  const studentStatsMap = new Map();

  studentsResult.rows.forEach((student) => {
    studentStatsMap.set(student.id, {
      studentId: student.id,
      studentName: student.name,
      studentNo: student.student_no,
      achieved: 0,
      max: 0,
      resultCount: 0,
      wrongQuestions: [],
    });
  });

  results.forEach((row) => {
    const student = studentStatsMap.get(row.student_id);

    if (!student) {
      return;
    }

    const score = Number(row.score);
    const maxScore = Number(row.max_score);
    student.achieved += score;
    student.max += maxScore;
    student.resultCount += 1;

    if (score < maxScore - 0.001) {
      student.wrongQuestions.push({
        questionNo: row.question_no,
        score,
        maxScore,
        knowledgePoints: asJsonArray(row.knowledge_points),
      });
    }
  });

  const studentStats = Array.from(studentStatsMap.values()).map((student) => ({
    ...student,
    achieved: Math.round(student.achieved * 100) / 100,
    max: Math.round(student.max * 100) / 100,
    rate: roundRate(student.max > 0 ? student.achieved / student.max : 0),
  }));
  const gradedStudentCount = questions.length
    ? studentStats.filter((student) => student.resultCount >= questions.length).length
    : 0;
  const totalAchieved = results.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const totalMax = results.reduce((sum, row) => sum + Number(row.max_score || 0), 0);
  const gradedStudents = studentStats.filter((student) => student.resultCount > 0);
  const passCount = gradedStudents.filter((student) => student.rate >= 0.6).length;
  const distribution = [
    { label: "优秀（90%以上）", count: gradedStudents.filter((student) => student.rate >= 0.9).length },
    { label: "良好（80%-90%）", count: gradedStudents.filter((student) => student.rate >= 0.8 && student.rate < 0.9).length },
    { label: "及格（60%-80%）", count: gradedStudents.filter((student) => student.rate >= 0.6 && student.rate < 0.8).length },
    { label: "待提升（60%以下）", count: gradedStudents.filter((student) => student.rate < 0.6).length },
  ];
  const savedAnalysis = analysisResult.rowCount
    ? {
        summary: analysisResult.rows[0].summary,
        model: analysisResult.rows[0].model,
        createdAt: analysisResult.rows[0].created_at,
      }
    : null;

  return {
    batch: {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      createdAt: batch.created_at,
    },
    exam: {
      id: batch.exam_id,
      name: batch.exam_name,
      subject: batch.subject,
      examDate: batch.exam_date,
      totalScore: Number(batch.total_score || 0),
      classId: batch.class_id,
      className: batch.class_name || "",
    },
    overview: {
      studentCount: studentsResult.rowCount,
      gradedStudentCount,
      gradedResultCount: results.length,
      achieved: Math.round(totalAchieved * 100) / 100,
      max: Math.round(totalMax * 100) / 100,
      rate: roundRate(totalMax > 0 ? totalAchieved / totalMax : 0),
      wrongResultCount: results.filter((row) => Number(row.score) < Number(row.max_score) - 0.001).length,
      passCount,
      passRate: gradedStudents.length ? roundRate(passCount / gradedStudents.length) : 0,
    },
    questions,
    knowledgePoints,
    students: studentStats,
    distribution,
    savedAnalysis,
  };
}

async function getBatchAnalysisAiPayload(batchId) {
  const analysis = await getBatchAnalysis(batchId);
  const wrongQuestionIds = new Set(
    analysis.questions.filter((question) => question.wrongCount > 0).map((question) => question.id)
  );

  if (!wrongQuestionIds.size) {
    return { analysis, questions: [] };
  }

  const imageResult = await getPool().query(
    `
      SELECT
        gr.student_id,
        gr.question_id,
        ai.mime_type,
        ai.image_data
      FROM grading_results gr
      JOIN grading_jobs j ON j.id = gr.job_id
      JOIN answer_crops ac ON ac.id = j.answer_crop_id
      JOIN uploaded_images ai ON ai.id = ac.crop_image_id
      WHERE gr.batch_id = $1 AND gr.score IS NOT NULL AND gr.score < gr.max_score - 0.001
      ORDER BY gr.created_at ASC
    `,
    [batchId]
  );
  const imageMap = new Map();

  for (const row of imageResult.rows) {
    const key = `${row.student_id}|${row.question_id}`;
    const entry = imageMap.get(key) || [];
    entry.push(row);
    imageMap.set(key, entry);
  }

  let imageBudget = 10;
  const questions = [];

  for (const question of analysis.questions) {
    if (!question.wrongCount) {
      continue;
    }

    const wrongAnswers = [];

    for (const wrong of question.wrongStudents) {
      const images = imageMap.get(`${wrong.studentId}|${question.id}`) || [];
      let image = "";

      if (images.length && imageBudget > 0) {
        const source = images[0];

        try {
          const buffer = await sharp(Buffer.from(source.image_data))
            .resize({ width: 760, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
          image = `data:image/jpeg;base64,${buffer.toString("base64")}`;
          imageBudget -= 1;
        } catch {
          image = "";
        }
      }

      wrongAnswers.push({
        studentName: wrong.studentName,
        score: wrong.score,
        maxScore: wrong.maxScore,
        analysis: wrong.analysis,
        deductions: wrong.deductions,
        image,
      });
    }

    questions.push({
      questionNo: question.questionNo,
      questionTitle: question.questionTitle,
      questionType: question.questionType,
      knowledgePoints: question.knowledgePoints,
      maxScore: question.maxScore,
      wrongCount: question.wrongCount,
      wrongAnswers,
    });
  }

  return { analysis, questions };
}

async function saveBatchAnalysis(batchId, summary, model) {
  const result = await getPool().query(
    `
      INSERT INTO assignment_analyses (id, batch_id, summary, model)
      VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT (batch_id)
      DO UPDATE SET summary = EXCLUDED.summary, model = EXCLUDED.model, created_at = now()
      RETURNING id, batch_id, summary, model, created_at
    `,
    [randomUUID(), batchId, JSON.stringify(summary || {}), model || ""]
  );

  return result.rows[0];
}

async function getStudentHistoryAnalysis(studentId) {
  const studentResult = await getPool().query(
    `
      SELECT s.id, s.class_id, c.name AS class_name, s.name, s.student_no
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id = $1
    `,
    [studentId]
  );

  if (studentResult.rowCount === 0) {
    throw new Error("学生不存在。");
  }

  const result = await getPool().query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (gr.exam_id, gr.question_id) gr.*
        FROM grading_results gr
        WHERE gr.student_id = $1 AND gr.score IS NOT NULL
        ORDER BY gr.exam_id, gr.question_id, gr.created_at DESC
      )
      SELECT
        latest.student_id,
        latest.score,
        latest.max_score,
        latest.question_id,
        q.question_no,
        q.title AS question_title,
        q.knowledge_points,
        q.question_type,
        e.id AS exam_id,
        e.name AS exam_name,
        e.subject,
        e.exam_date,
        latest.created_at
      FROM latest
      JOIN exam_questions q ON q.id = latest.question_id
      JOIN exams e ON e.id = latest.exam_id
      ORDER BY e.exam_date NULLS LAST, latest.created_at ASC
    `,
    [studentId]
  );

  const rows = result.rows;
  const knowledgePoints = buildTagStats(rows, (row) => asJsonArray(row.knowledge_points));
  const questionTypes = buildTagStats(rows, (row) => [row.question_type || "未标注题型"]);
  const buckets = { mastered: [], developing: [], weak: [] };
  const typeBuckets = { mastered: [], developing: [], weak: [] };

  knowledgePoints.forEach((item) => buckets[item.classification].push(item));
  questionTypes.forEach((item) => typeBuckets[item.classification].push(item));

  const examMap = new Map();

  rows.forEach((row) => {
    const exam = examMap.get(row.exam_id) || {
      examId: row.exam_id,
      name: row.exam_name,
      subject: row.subject || "",
      examDate: row.exam_date,
      achieved: 0,
      max: 0,
      questionCount: 0,
    };

    exam.achieved += Number(row.score || 0);
    exam.max += Number(row.max_score || 0);
    exam.questionCount += 1;
    examMap.set(row.exam_id, exam);
  });

  const recentExams = Array.from(examMap.values())
    .map((exam) => ({
      ...exam,
      achieved: Math.round(exam.achieved * 100) / 100,
      max: Math.round(exam.max * 100) / 100,
      rate: roundRate(exam.max > 0 ? exam.achieved / exam.max : 0),
    }))
    .sort((left, right) => {
      const leftTime = left.examDate ? new Date(left.examDate).getTime() : 0;
      const rightTime = right.examDate ? new Date(right.examDate).getTime() : 0;
      return rightTime - leftTime;
    });
  const weakQuestions = rows
    .map((row) => ({
      questionNo: row.question_no,
      questionTitle: row.question_title,
      questionType: row.question_type || "",
      knowledgePoints: asJsonArray(row.knowledge_points),
      examId: row.exam_id,
      examName: row.exam_name,
      score: Number(row.score),
      maxScore: Number(row.max_score),
      rate: roundRate(Number(row.max_score) > 0 ? Number(row.score) / Number(row.max_score) : 0),
    }))
    .filter((question) => question.rate < MASTERY_DEVELOPING)
    .sort((left, right) => left.rate - right.rate);
  const totalAchieved = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const totalMax = rows.reduce((sum, row) => sum + Number(row.max_score || 0), 0);

  return {
    student: {
      id: studentResult.rows[0].id,
      classId: studentResult.rows[0].class_id,
      className: studentResult.rows[0].class_name || "",
      name: studentResult.rows[0].name,
      studentNo: studentResult.rows[0].student_no,
    },
    overview: {
      examCount: examMap.size,
      questionCount: rows.length,
      achieved: Math.round(totalAchieved * 100) / 100,
      max: Math.round(totalMax * 100) / 100,
      rate: roundRate(totalMax > 0 ? totalAchieved / totalMax : 0),
      thresholds: { mastered: MASTERY_MASTERED, developing: MASTERY_DEVELOPING },
    },
    knowledgePoints,
    questionTypes,
    buckets,
    typeBuckets,
    recentExams,
    weakQuestions,
  };
}

async function getClassHistoryAnalysis(classId) {
  const classItem = await getClassRecord(classId);
  const result = await getPool().query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (gr.student_id, gr.exam_id, gr.question_id) gr.*
        FROM grading_results gr
        JOIN exams e ON e.id = gr.exam_id
        LEFT JOIN students s ON s.id = gr.student_id
        WHERE COALESCE(e.class_id, s.class_id) = $1 AND gr.score IS NOT NULL
        ORDER BY gr.student_id, gr.exam_id, gr.question_id, gr.created_at DESC
      )
      SELECT
        latest.student_id,
        s.name AS student_name,
        s.student_no,
        latest.score,
        latest.max_score,
        latest.question_id,
        q.question_no,
        q.title AS question_title,
        q.knowledge_points,
        q.question_type,
        e.id AS exam_id,
        e.name AS exam_name,
        e.exam_date
      FROM latest
      JOIN students s ON s.id = latest.student_id
      JOIN exam_questions q ON q.id = latest.question_id
      JOIN exams e ON e.id = latest.exam_id
      ORDER BY s.student_no ASC, s.name ASC, e.created_at ASC
    `,
    [classId]
  );

  const rows = result.rows;
  const buildClassTagStats = (getTags) => {
    const tagMap = new Map();

    rows.forEach((row) => {
      const score = Number(row.score);
      const maxScore = Number(row.max_score);

      if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
        return;
      }

      getTags(row).filter(Boolean).forEach((tag) => {
        const stats = tagMap.get(tag) || {
          name: tag,
          achieved: 0,
          max: 0,
          attempts: 0,
          questionIds: new Set(),
          studentMap: new Map(),
        };

        stats.achieved += score;
        stats.max += maxScore;
        stats.attempts += 1;
        stats.questionIds.add(row.question_id);
        const student = stats.studentMap.get(row.student_id) || {
          studentId: row.student_id,
          name: row.student_name,
          studentNo: row.student_no,
          achieved: 0,
          max: 0,
        };
        student.achieved += score;
        student.max += maxScore;
        stats.studentMap.set(row.student_id, student);
        tagMap.set(tag, stats);
      });
    });

    return Array.from(tagMap.values())
      .map((stats) => {
        const students = Array.from(stats.studentMap.values()).map((student) => ({
          ...student,
          achieved: Math.round(student.achieved * 100) / 100,
          max: Math.round(student.max * 100) / 100,
          rate: roundRate(student.max > 0 ? student.achieved / student.max : 0),
        }));
        const masteredStudents = students.filter((student) => student.rate >= MASTERY_MASTERED);
        const developingStudents = students.filter(
          (student) => student.rate >= MASTERY_DEVELOPING && student.rate < MASTERY_MASTERED
        );
        const weakStudents = students.filter((student) => student.rate < MASTERY_DEVELOPING);
        const studentCount = students.length;
        const rate = stats.max > 0 ? stats.achieved / stats.max : 0;
        let label = "部分学生掌握";

        if (studentCount > 0 && masteredStudents.length / studentCount >= 0.8) {
          label = "大部分学生已掌握";
        } else if (studentCount > 0 && weakStudents.length / studentCount >= 0.5) {
          label = "大部分学生还未掌握";
        }

        return {
          name: stats.name,
          attempts: stats.attempts,
          questionCount: stats.questionIds.size,
          achieved: Math.round(stats.achieved * 100) / 100,
          max: Math.round(stats.max * 100) / 100,
          rate: roundRate(rate),
          studentCount,
          masteredCount: masteredStudents.length,
          developingCount: developingStudents.length,
          weakCount: weakStudents.length,
          masteredStudents: masteredStudents.map((student) => student.name),
          developingStudents: developingStudents.map((student) => student.name),
          weakStudents: weakStudents.map((student) => student.name),
          label,
        };
      })
      .sort((left, right) => left.rate - right.rate || right.studentCount - left.studentCount);
  };

  const knowledgePoints = buildClassTagStats((row) => asJsonArray(row.knowledge_points));
  const questionTypes = buildClassTagStats((row) => [row.question_type || "未标注题型"]);
  const studentMap = new Map();

  rows.forEach((row) => {
    const student = studentMap.get(row.student_id) || {
      studentId: row.student_id,
      name: row.student_name,
      studentNo: row.student_no,
      achieved: 0,
      max: 0,
      questionCount: 0,
    };
    student.achieved += Number(row.score || 0);
    student.max += Number(row.max_score || 0);
    student.questionCount += 1;
    studentMap.set(row.student_id, student);
  });

  const students = Array.from(studentMap.values())
    .map((student) => {
      return {
        ...student,
        achieved: Math.round(student.achieved * 100) / 100,
        max: Math.round(student.max * 100) / 100,
        rate: roundRate(student.max > 0 ? student.achieved / student.max : 0),
        weakKnowledgePoints: knowledgePoints
          .filter((item) => item.weakStudents.includes(student.name))
          .map((item) => item.name),
        masteredKnowledgePoints: knowledgePoints
          .filter((item) => item.masteredStudents.includes(student.name))
          .map((item) => item.name),
      };
    })
    .sort((left, right) => left.rate - right.rate);
  const totalAchieved = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const totalMax = rows.reduce((sum, row) => sum + Number(row.max_score || 0), 0);
  const examIds = new Set(rows.map((row) => row.exam_id));

  return {
    classInfo: classItem,
    overview: {
      studentCount: students.length,
      examCount: examIds.size,
      resultCount: rows.length,
      achieved: Math.round(totalAchieved * 100) / 100,
      max: Math.round(totalMax * 100) / 100,
      rate: roundRate(totalMax > 0 ? totalAchieved / totalMax : 0),
      thresholds: { mastered: MASTERY_MASTERED, developing: MASTERY_DEVELOPING },
    },
    knowledgePoints,
    questionTypes,
    students,
  };
}

async function processScanBatch(batchId) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const batchResult = await client.query(
      `
        SELECT b.id, b.exam_id
        FROM scan_batches b
        WHERE b.id = $1
      `,
      [batchId]
    );

    if (batchResult.rowCount === 0) {
      throw new Error("批次不存在。");
    }

    const batch = batchResult.rows[0];
    const templateResult = await client.query(
      `
        SELECT t.id
        FROM paper_templates t
        WHERE t.exam_id = $1
        ORDER BY t.created_at DESC
        LIMIT 1
      `,
      [batch.exam_id]
    );

    if (templateResult.rowCount === 0) {
      throw new Error("当前考试还没有试卷模板。");
    }

    const regionsResult = await client.query(
      `
        SELECT r.*, q.question_no
        FROM template_regions r
        JOIN exam_questions q ON q.id = r.question_id
        WHERE r.template_id = $1
        ORDER BY q.created_at ASC
      `,
      [templateResult.rows[0].id]
    );

    if (regionsResult.rowCount === 0) {
      throw new Error("当前模板还没有配置题目区域。");
    }

    const pagesResult = await client.query(
      `
        SELECT
          p.id,
          p.student_id,
          p.original_name,
          ui.mime_type,
          ui.image_data
        FROM scanned_pages p
        JOIN uploaded_images ui ON ui.id = p.image_id
        WHERE p.batch_id = $1
        ORDER BY p.created_at ASC
      `,
      [batchId]
    );

    if (pagesResult.rowCount === 0) {
      throw new Error("当前批次还没有上传扫描答卷。");
    }

    const unboundPage = pagesResult.rows.find((row) => !row.student_id);
    if (unboundPage) {
      throw new Error(`扫描答卷 ${unboundPage.original_name} 还没有绑定学生。`);
    }

    await client.query("DELETE FROM answer_crops WHERE batch_id = $1", [batchId]);

    let createdCropCount = 0;

    for (const page of pagesResult.rows) {
      createdCropCount += await cropPageIntoJobs(client, batchId, page, regionsResult.rows);
    }

    await client.query("UPDATE scan_batches SET status = 'ready' WHERE id = $1", [batchId]);
    await client.query("COMMIT");

    return { cropCount: createdCropCount, jobCount: createdCropCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimNextGradingJob(batchId, studentId) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = studentId
      ? await client.query(
          `
            SELECT j.id
            FROM grading_jobs j
            JOIN answer_crops ac ON ac.id = j.answer_crop_id
            WHERE j.batch_id = $1
              AND ac.student_id = $2
              AND j.job_kind = 'crop'
              AND j.status IN ('pending', 'failed')
              AND j.attempts < 3
            ORDER BY j.created_at ASC
            LIMIT 1
            FOR UPDATE OF j SKIP LOCKED
          `,
          [batchId, studentId]
        )
      : await client.query(
          `
            SELECT id
            FROM grading_jobs
            WHERE batch_id = $1 AND job_kind = 'crop' AND status IN ('pending', 'failed') AND attempts < 3
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `,
          [batchId]
        );

    if (result.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const jobId = result.rows[0].id;
    await client.query(
      `
        UPDATE grading_jobs
        SET status = 'running', attempts = attempts + 1, error = '', started_at = now()
        WHERE id = $1
      `,
      [jobId]
    );
    await client.query("UPDATE scan_batches SET status = 'grading' WHERE id = $1", [batchId]);
    await client.query("COMMIT");

    return jobId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getGradingJobPayload(jobId) {
  const result = await getPool().query(
    `
      SELECT
        j.id AS job_id,
        j.batch_id,
        b.exam_id,
        e.name AS exam_name,
        q.id AS question_id,
        q.question_no,
        q.title AS question_title,
        q.max_score,
        q.rubric,
        q.knowledge_points,
        ac.student_id,
        s.name AS student_name,
        s.student_no,
        answer_img.mime_type AS answer_mime_type,
        answer_img.image_data AS answer_image_data,
        template_img.mime_type AS template_mime_type,
        template_img.image_data AS template_image_data,
        r.x_ratio,
        r.y_ratio,
        r.width_ratio,
        r.height_ratio
      FROM grading_jobs j
      JOIN answer_crops ac ON ac.id = j.answer_crop_id
      JOIN scan_batches b ON b.id = j.batch_id
      JOIN exams e ON e.id = b.exam_id
      JOIN exam_questions q ON q.id = ac.question_id
      JOIN students s ON s.id = ac.student_id
      JOIN uploaded_images answer_img ON answer_img.id = ac.crop_image_id
      JOIN paper_templates t ON t.exam_id = e.id
      JOIN uploaded_images template_img ON template_img.id = t.image_id
      JOIN template_regions r ON r.template_id = t.id AND r.question_id = q.id
      WHERE j.id = $1
      ORDER BY t.created_at DESC
      LIMIT 1
    `,
    [jobId]
  );

  if (result.rowCount === 0) {
    throw new Error("评分任务不存在。");
  }

  const row = result.rows[0];
  const templateBuffer = Buffer.from(row.template_image_data);
  const metadata = await sharp(templateBuffer).metadata();
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  const left = Math.max(0, Math.round(Number(row.x_ratio) * sourceWidth));
  const top = Math.max(0, Math.round(Number(row.y_ratio) * sourceHeight));
  const desiredWidth = Math.max(1, Math.round(Number(row.width_ratio) * sourceWidth));
  const desiredHeight = Math.max(1, Math.round(Number(row.height_ratio) * sourceHeight));
  const width = Math.min(desiredWidth, sourceWidth - left);
  const height = Math.min(desiredHeight, sourceHeight - top);
  const questionCrop = await sharp(templateBuffer)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();

  return {
    jobId: row.job_id,
    batchId: row.batch_id,
    examId: row.exam_id,
    examName: row.exam_name,
    studentId: row.student_id,
    studentName: row.student_name,
    studentNo: row.student_no,
    questionId: row.question_id,
    questionNo: row.question_no,
    questionTitle: row.question_title,
    maxScore: Number(row.max_score),
    rubric: row.rubric,
    knowledgePoints: asJsonArray(row.knowledge_points),
    questionImage: bufferToDataUrl("image/png", questionCrop),
    answerImage: bufferToDataUrl(row.answer_mime_type, row.answer_image_data),
    answerName: `${row.student_name}-${row.question_no}`,
  };
}

async function completeGradingJob(jobPayload, grade) {
  const result = grade.result && typeof grade.result === "object" ? grade.result : {};
  const score =
    result.score === null || result.score === undefined || result.score === ""
      ? null
      : getNumericValue(result.score);

  if (score === null) {
    throw new Error("AI 返回的评分格式不正确，请重新批改本题。");
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM grading_results WHERE job_id = $1", [jobPayload.jobId]);
    await client.query(
      `
        INSERT INTO grading_results (
          id,
          job_id,
          batch_id,
          exam_id,
          student_id,
          question_id,
          score,
          max_score,
          level,
          analysis,
          deductions,
          suggestions,
          raw_content,
          ai_result
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb)
      `,
      [
        randomUUID(),
        jobPayload.jobId,
        jobPayload.batchId,
        jobPayload.examId,
        jobPayload.studentId,
        jobPayload.questionId,
        score,
        getNumericValue(result.max_score ?? jobPayload.maxScore) ?? jobPayload.maxScore,
        result.level || "",
        result.analysis || "",
        JSON.stringify(asJsonArray(result.deductions)),
        JSON.stringify(asJsonArray(result.suggestions)),
        grade.rawContent || "",
        Object.keys(result).length ? JSON.stringify(result) : null,
      ]
    );

    await client.query(
      `
        UPDATE grading_jobs
        SET status = 'done', finished_at = now(), error = ''
        WHERE id = $1
      `,
      [jobPayload.jobId]
    );
    await finishBatchIfSettled(client, jobPayload.batchId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failGradingJob(jobId, errorMessage) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
        UPDATE grading_jobs
        SET status = 'failed', finished_at = now(), error = $2
        WHERE id = $1
        RETURNING batch_id
      `,
      [jobId, String(errorMessage || "评分失败。").slice(0, 1000)]
    );

    if (result.rowCount) {
      await finishBatchIfSettled(client, result.rows[0].batch_id);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finishBatchIfSettled(client, batchId) {
  const result = await client.query(
    `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('done', 'failed')) AS settled,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM grading_jobs
      WHERE batch_id = $1
    `,
    [batchId]
  );
  const row = result.rows[0];

  if (Number(row.total) > 0 && Number(row.total) === Number(row.settled)) {
    await client.query(
      "UPDATE scan_batches SET status = $2 WHERE id = $1",
      [batchId, Number(row.failed) > 0 ? "needs_review" : "done"]
    );
  }
}

async function getBatchResults(batchId) {
  const progressResult = await getPool().query(
    `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'running') AS running,
        COUNT(*) FILTER (WHERE status = 'done') AS done,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM grading_jobs
      WHERE batch_id = $1
    `,
    [batchId]
  );
  const summaryResult = await getPool().query(
    `
      SELECT
        s.id AS student_id,
        s.name AS student_name,
        s.student_no,
        COUNT(DISTINCT q.id) AS question_count,
        COALESCE(SUM(gr.score), 0) AS total_score,
        COALESCE(SUM(q.max_score), 0) AS max_score
      FROM scanned_pages p
      JOIN students s ON s.id = p.student_id
      JOIN scan_batches b ON b.id = p.batch_id
      JOIN exam_questions q ON q.exam_id = b.exam_id
      LEFT JOIN grading_results gr ON gr.batch_id = p.batch_id AND gr.student_id = s.id AND gr.question_id = q.id
      WHERE p.batch_id = $1
      GROUP BY s.id, s.name, s.student_no
      ORDER BY s.student_no ASC, s.name ASC
    `,
    [batchId]
  );
  const detailResult = await getPool().query(
    `
      SELECT
        gr.id,
        gr.student_id,
        s.name AS student_name,
        s.student_no,
        gr.question_id,
        q.question_no,
        q.title AS question_title,
        gr.score,
        gr.max_score,
        gr.level,
        gr.analysis,
        gr.deductions,
        gr.suggestions,
        gr.created_at
      FROM grading_results gr
      JOIN students s ON s.id = gr.student_id
      JOIN exam_questions q ON q.id = gr.question_id
      WHERE gr.batch_id = $1
      ORDER BY s.student_no ASC, s.name ASC, q.created_at ASC
    `,
    [batchId]
  );
  const failedResult = await getPool().query(
    `
      SELECT
        j.id,
        j.error,
        j.attempts,
        s.id AS student_id,
        s.name AS student_name,
        s.student_no,
        q.id AS question_id,
        q.question_no,
        q.title AS question_title,
        q.max_score
      FROM grading_jobs j
      JOIN answer_crops ac ON ac.id = j.answer_crop_id
      JOIN students s ON s.id = ac.student_id
      JOIN exam_questions q ON q.id = ac.question_id
      WHERE j.batch_id = $1 AND j.status = 'failed'
      ORDER BY s.student_no ASC, s.name ASC, q.created_at ASC
    `,
    [batchId]
  );

  const progress = progressResult.rows[0] || {};

  return {
    progress: {
      total: Number(progress.total || 0),
      pending: Number(progress.pending || 0),
      running: Number(progress.running || 0),
      done: Number(progress.done || 0),
      failed: Number(progress.failed || 0),
    },
    summary: summaryResult.rows.map((row) => ({
      studentId: row.student_id,
      studentName: row.student_name,
      studentNo: row.student_no,
      questionCount: Number(row.question_count || 0),
      totalScore: Number(row.total_score || 0),
      maxScore: Number(row.max_score || 0),
    })),
    details: detailResult.rows.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      studentName: row.student_name,
      studentNo: row.student_no,
      questionId: row.question_id,
      questionNo: row.question_no,
      questionTitle: row.question_title,
      score: row.score === null ? null : Number(row.score),
      maxScore: Number(row.max_score || 0),
      level: row.level,
      analysis: row.analysis,
      deductions: asJsonArray(row.deductions),
      suggestions: asJsonArray(row.suggestions),
      createdAt: row.created_at,
    })),
    failures: failedResult.rows.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      studentName: row.student_name,
      studentNo: row.student_no,
      questionId: row.question_id,
      questionNo: row.question_no,
      questionTitle: row.question_title,
      maxScore: Number(row.max_score || 0),
      attempts: Number(row.attempts || 0),
      error: row.error,
    })),
  };
}

// Desk writes and worker transitions always lock batch first, then jobs/pages.
// This serializes capture/confirm/start and makes the final batch status race-free.
const DESK_MAX_ATTEMPTS = 3;
const DESK_LEASE_SECONDS = 120;

function deskError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function deskId(value, label = "ID") {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) {
    throw deskError(`${label} 格式不正确。`);
  }
  return value.toLowerCase();
}

function deskAccount(account) {
  if (typeof account !== "string" || !account.trim()) throw deskError("请先登录。", 401);
  return account.trim();
}

async function deskTransaction(work, readOnly = false) {
  const client = await getPool().connect();
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deskRecord(client, examId, account, lock = false) {
  const result = await client.query(`
    SELECT e.id AS exam_id, e.name, e.answer_image_id, e.student_order_snapshot,
      b.id AS batch_id, b.status, b.capture_version, b.confirmed_version,
      b.confirmed_page_ids, b.grading_started_at, b.pages_per_student
    FROM exams e JOIN scan_batches b ON b.exam_id = e.id AND b.desk_managed
    WHERE e.id = $1 AND e.teacher_account = $2 AND e.desk_managed
    ${lock ? "FOR UPDATE OF b" : ""}
  `, [deskId(examId, "作业ID"), deskAccount(account)]);
  if (!result.rowCount) throw forbiddenError("作业不存在或无权访问。");
  return result.rows[0];
}

function requireDeskDraft(record) {
  if (record.grading_started_at) throw deskError("已开始批改，不能修改照片或题目。", 409);
}

function sortDeskRoster(rows) {
  // Compare numeric student numbers without losing precision (e.g. long IDs).
  return rows.map((s) => ({ id: s.id, name: s.name, studentNo: s.student_no || "" })).sort((a, b) => {
    const left = a.studentNo.trim(), right = b.studentNo.trim();
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn && BigInt(left) !== BigInt(right)) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    if (!ln && left !== right) return left.localeCompare(right, "zh-CN", { numeric: true });
    return a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
  });
}

async function validateDeskImage(image) {
  let parsed;
  try {
    if (typeof image !== "string" || image.length > 28 * 1024 * 1024) throw new Error();
    parsed = parseDataUrl(image);
    if (parsed.buffer.length > 20 * 1024 * 1024) throw new Error();
    const decoder = sharp(parsed.buffer, { limitInputPixels: 40000000 });
    const metadata = await decoder.metadata();
    const expectedFormat = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[parsed.mimeType];
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40000000 ||
        (metadata.pages || 1) > 1 || metadata.format !== expectedFormat) throw new Error();
    await decoder.resize(1, 1).toBuffer(); // Decode as well as inspect headers before replacing a good page.
  } catch {
    throw deskError("请提供有效的单页 PNG、JPG 或 WEBP 图片（不超过 20MB、4000万像素）。");
  }
  return parsed;
}

async function insertDeskImage(client, image, kind, name) {
  const id = await createImageUpload(client, { image, kind, name });
  await client.query("UPDATE uploaded_images SET desk_private = true WHERE id = $1", [id]);
  return id;
}

const clampNumber = (value, low, high) => Math.min(high, Math.max(low, value));

async function preparePageImage(buffer) {
  const rotated = await sharp(buffer).rotate().toBuffer();
  const metadata = await sharp(rotated).metadata();
  return { buffer: rotated, width: metadata.width, height: metadata.height };
}

async function cropPreparedRegion(prepared, box) {
  if (!prepared || !Array.isArray(box) || box.length !== 4) return null;
  const [x, y, width, height] = box.map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const pad = 6;
  const left = clampNumber(Math.floor(x * prepared.width) - pad, 0, prepared.width - 1);
  const top = clampNumber(Math.floor(y * prepared.height) - pad, 0, prepared.height - 1);
  const right = clampNumber(Math.ceil((x + width) * prepared.width) + pad, left + 1, prepared.width);
  const bottom = clampNumber(Math.ceil((y + height) * prepared.height) + pad, top + 1, prepared.height);
  try {
    return await sharp(prepared.buffer).extract({
      left, top, width: right - left, height: bottom - top,
    }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}

async function cropRegionDataUrl(prepared, box) {
  const crop = await cropPreparedRegion(prepared, box);
  return crop ? bufferToDataUrl("image/jpeg", crop) : "";
}

async function getExamStructure(executor, examId) {
  const result = await executor.query(`
    SELECT q.id, q.question_no, q.title, q.max_score, q.question_type, q.sub_question_count,
      COALESCE(json_agg(json_build_object('id', s.id, 'label', s.label, 'maxScore', s.max_score, 'ordinal', s.ordinal)
        ORDER BY s.ordinal) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS subs
    FROM exam_questions q
    LEFT JOIN exam_sub_questions s ON s.question_id = q.id
    WHERE q.exam_id = $1
    GROUP BY q.id
    ORDER BY q.created_at, q.question_no
  `, [examId]);
  return result.rows.map((row) => ({
    id: row.id, questionNo: row.question_no, title: row.title,
    maxScore: Number(row.max_score), questionType: row.question_type || "",
    subs: asJsonArray(row.subs).map((sub) => ({
      id: sub.id, label: sub.label || "", maxScore: Number(sub.maxScore), ordinal: Number(sub.ordinal) || 0,
    })),
  }));
}

async function insertDeskQuestions(client, examId, questions, autoGenerated) {
  const inserted = [];
  for (const q of questions) {
    const questionId = randomUUID();
    await client.query(`INSERT INTO exam_questions
      (id, exam_id, question_no, title, max_score, question_type, sub_question_count, auto_generated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [questionId, examId, q.questionNo, q.title, q.maxScore, q.questionType || "", q.subs.length, autoGenerated]);
    const subIds = [];
    for (const [index, sub] of q.subs.entries()) {
      const subId = randomUUID();
      await client.query(`INSERT INTO exam_sub_questions (id, question_id, label, ordinal, max_score)
        VALUES ($1, $2, $3, $4, $5)`, [subId, questionId, sub.label || "", index, sub.maxScore]);
      subIds.push(subId);
    }
    inserted.push({ ...q, id: questionId, subIds });
  }
  await client.query("UPDATE exams SET total_score = $2 WHERE id = $1", [examId, questions.reduce((sum, q) => sum + q.maxScore, 0)]);
  return inserted;
}

async function createDeskExam(payload, account, recognizeAnswerQuestions, locateAnswerKey = null) {
  const classId = deskId(payload.classId, "班级ID");
  account = deskAccount(account);
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name || name.length > 200) throw deskError("作业名称必须为 1 至 200 字。");
  if (typeof payload.examDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.examDate) ||
      !Number.isFinite(Date.parse(payload.examDate)) || new Date(payload.examDate).toISOString().slice(0, 10) !== payload.examDate) {
    throw deskError("请选择有效的作业日期（YYYY-MM-DD）。");
  }
  const pagesPerStudent = Number(payload.pagesPerStudent ?? 1);
  if (!Number.isInteger(pagesPerStudent) || pagesPerStudent < 1 || pagesPerStudent > 4) {
    throw deskError("每人页数必须为 1 至 4 页。");
  }
  await assertClassOwnership(classId, account);
  const answerImage = await validateDeskImage(payload.answerImage);
  // Recognition occurs exactly once, outside the write transaction. Failure leaves no partial exam/upload.
  const recognized = await recognizeAnswerQuestions(payload.answerImage);
  const questions = validateDeskQuestions(recognized.questions);
  // One answer-key locate pass; every crop is cached and reused by all students.
  let answerRegions = [];
  if (locateAnswerKey) {
    try {
      const boxes = await locateAnswerKey(payload.answerImage, questions);
      if (boxes) {
        answerRegions = await buildRegionsFromBoxes({
          image: answerImage.buffer,
          questions: questions.map((question) => ({ ...question, id: null, subs: question.subs })),
          boxes,
        });
      }
    } catch (error) {
      console.error("Answer key locate failed:", error?.message || error);
    }
  }
  const preparedAnswer = answerRegions.some((region) => region.bbox) ? await preparePageImage(answerImage.buffer) : null;

  return deskTransaction(async (client) => {
    const owned = await client.query("SELECT id FROM classes WHERE id = $1 AND teacher_account = $2 FOR UPDATE", [classId, account]);
    if (!owned.rowCount) throw forbiddenError("班级不存在或无权访问。");
    const roster = await client.query("SELECT id, name, student_no FROM students WHERE class_id = $1 AND teacher_account = $2 FOR SHARE", [classId, account]);
    const snapshot = sortDeskRoster(roster.rows);
    if (!snapshot.length) throw deskError("班级名单为空，请先导入学生。");
    const answerId = await insertDeskImage(client, payload.answerImage, "answer", `${name}-教师答案`);
    const examId = randomUUID(), batchId = randomUUID();
    await client.query(`INSERT INTO exams
      (id, class_id, name, exam_date, teacher_account, desk_managed, answer_image_id, answer_total_score, student_order_snapshot)
      VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8::jsonb)`,
    [examId, classId, name, payload.examDate, account, answerId, questions.reduce((sum, q) => sum + q.maxScore, 0), JSON.stringify(snapshot)]);
    await client.query(`INSERT INTO scan_batches (id, exam_id, name, desk_managed, pages_per_student)
      VALUES ($1, $2, $3, true, $4)`, [batchId, examId, name, pagesPerStudent]);
    const inserted = await insertDeskQuestions(client, examId, questions, true);
    for (const [index, question] of inserted.entries()) {
      const region = answerRegions[index];
      if (!region?.bbox || !preparedAnswer) continue;
      const questionCrop = await cropRegionDataUrl(preparedAnswer, region.bbox);
      const cropId = questionCrop
        ? await insertDeskImage(client, questionCrop, "answer_crop", `${name}-${question.questionNo}-答案`)
        : null;
      await client.query("UPDATE exam_questions SET answer_box = $2::jsonb, answer_crop_image_id = $3 WHERE id = $1",
        [question.id, JSON.stringify(region.bbox), cropId]);
      for (const [subIndex, subId] of question.subIds.entries()) {
        const subBox = region.subs?.[subIndex]?.bbox || region.bbox;
        const subCrop = await cropRegionDataUrl(preparedAnswer, subBox);
        const subCropId = subCrop
          ? await insertDeskImage(client, subCrop, "answer_crop", `${name}-${question.questionNo}-${subIndex + 1}`)
          : null;
        await client.query("UPDATE exam_sub_questions SET answer_box = $2::jsonb, answer_crop_image_id = $3 WHERE id = $1",
          [subId, JSON.stringify(subBox), subCropId]);
      }
    }
    return { examId, batchId };
  });
}

async function resetDeskConfirmation(client, batchId) {
  await client.query(`UPDATE scan_batches SET capture_version = capture_version + 1,
    confirmed_version = NULL, confirmed_page_ids = '[]'::jsonb, status = 'draft' WHERE id = $1`, [batchId]);
}

function deskPagePosition(record, studentId, captureOrder, requestedPageNo) {
  const pagesPerStudent = Math.max(1, Math.min(4, Number(record.pages_per_student) || 1));
  const studentIndex = record.student_order_snapshot.findIndex((student) => student.id === studentId);
  const pageNo = Number.isInteger(requestedPageNo) ? requestedPageNo : (captureOrder % pagesPerStudent) + 1;
  if (studentIndex < 0 || Math.floor(captureOrder / pagesPerStudent) !== studentIndex) {
    throw deskError("学生与固定名单拍摄序号不匹配。", 409);
  }
  if (pageNo < 1 || pageNo > pagesPerStudent) throw deskError(`页号必须为 1 至 ${pagesPerStudent}。`);
  return { pageNo };
}

async function captureDeskPage(payload, account) {
  const studentId = deskId(payload.studentId, "学生ID");
  if (!Number.isInteger(payload.captureOrder) || payload.captureOrder < 0) throw deskError("拍摄序号必须为从 0 开始的整数。");
  if (payload.name !== undefined && (typeof payload.name !== "string" || payload.name.length > 500)) throw deskError("图片名称无效。");
  // Validate tenant and snapshot before image processing; revalidate under lock before writing.
  const preliminary = await deskRecord(getPool(), payload.examId, account);
  requireDeskDraft(preliminary);
  deskPagePosition(preliminary, studentId, payload.captureOrder, payload.pageNo);
  await validateDeskImage(payload.image);
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    requireDeskDraft(record);
    const locked = deskPagePosition(record, studentId, payload.captureOrder, payload.pageNo);
    const owned = await client.query("SELECT id FROM students WHERE id = $1 AND teacher_account = $2 FOR SHARE", [studentId, deskAccount(account)]);
    if (!owned.rowCount) throw forbiddenError("学生不存在或无权访问。");
    // Upload first; deletion, replacement and confirmation reset share this transaction.
    const imageId = await insertDeskImage(client, payload.image, "scanned_page", payload.name || "学生作答");
    const previous = await client.query(
      "DELETE FROM scanned_pages WHERE batch_id = $1 AND student_id = $2 AND page_no = $3 RETURNING image_id",
      [record.batch_id, studentId, locked.pageNo]);
    await client.query(`INSERT INTO scanned_pages (id, batch_id, student_id, image_id, original_name, capture_order, page_no)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), record.batch_id, studentId, imageId, payload.name || "", payload.captureOrder, locked.pageNo]);
    for (const row of previous.rows) await client.query("DELETE FROM uploaded_images WHERE id = $1 AND desk_private", [row.image_id]);
    await resetDeskConfirmation(client, record.batch_id);
    return {};
  });
}

function exactDeskPages(requested, current) {
  return Array.isArray(requested) && requested.length > 0 && requested.length === current.length &&
    new Set(requested).size === requested.length && current.every((id) => requested.includes(id));
}

async function confirmDeskPages(payload, account) {
  if (!Array.isArray(payload.pageIds) || !payload.pageIds.length) throw deskError("请先拍摄并确认照片。");
  const ids = payload.pageIds.map((id) => deskId(id, "照片ID"));
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    requireDeskDraft(record);
    const pages = await client.query("SELECT id FROM scanned_pages WHERE batch_id = $1 ORDER BY capture_order", [record.batch_id]);
    if (!exactDeskPages(ids, pages.rows.map((p) => p.id))) throw deskError("照片列表已改变，请刷新并重新确认。", 409);
    await client.query(`UPDATE scan_batches SET confirmed_version = capture_version,
      confirmed_page_ids = $2::jsonb, status = 'confirmed' WHERE id = $1`, [record.batch_id, JSON.stringify(ids)]);
    return {};
  });
}

async function updateDeskQuestions(payload, account) {
  const questions = validateDeskQuestions(payload.questions);
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    requireDeskDraft(record);
    // Question ids change, so cached answer crops and page templates are stale.
    await client.query(`DELETE FROM uploaded_images i USING exam_questions q
      WHERE i.id = q.answer_crop_image_id AND q.exam_id = $1 AND i.kind = 'answer_crop' AND i.desk_private`, [record.exam_id]);
    await client.query(`DELETE FROM uploaded_images i USING exam_sub_questions s
      JOIN exam_questions q ON q.id = s.question_id
      WHERE i.id = s.answer_crop_image_id AND q.exam_id = $1 AND i.kind = 'answer_crop' AND i.desk_private`, [record.exam_id]);
    await client.query("DELETE FROM page_layout_templates WHERE exam_id = $1", [record.exam_id]);
    await client.query("DELETE FROM student_page_regions WHERE batch_id = $1", [record.batch_id]);
    await client.query("DELETE FROM exam_questions WHERE exam_id = $1", [record.exam_id]);
    await insertDeskQuestions(client, record.exam_id, questions, false);
    await resetDeskConfirmation(client, record.batch_id);
    return {};
  });
}

async function loadDeskPageImage(client, pageId) {
  const result = await client.query(`SELECT p.id, p.student_id, p.page_no, p.capture_order, i.mime_type, i.image_data
    FROM scanned_pages p JOIN uploaded_images i ON i.id = p.image_id WHERE p.id = $1`, [pageId]);
  return result.rows[0] || null;
}

async function upsertStudentPageRegions(executor, { batchId, studentId, pageId, pageNo, regions, align, status }) {
  await executor.query(`INSERT INTO student_page_regions
    (id, batch_id, student_id, scanned_page_id, page_no, regions, align, status)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
    ON CONFLICT (scanned_page_id) DO UPDATE SET regions = EXCLUDED.regions, align = EXCLUDED.align,
      status = EXCLUDED.status, updated_at = now()`,
  [randomUUID(), batchId, studentId, pageId, pageNo, JSON.stringify(regions), JSON.stringify(align), status]);
}

async function buildDeskPageTemplates(client, record, structure, locateStudentBoxes, force) {
  const pages = await client.query(`SELECT id, student_id, page_no, capture_order FROM scanned_pages
    WHERE batch_id = $1 ORDER BY capture_order, page_no`, [record.batch_id]);
  if (!pages.rowCount) return { pageNumbers: [], built: [] };
  const pageNumbers = [...new Set(pages.rows.map((page) => Number(page.page_no || 1)))].sort((a, b) => a - b);
  if (!locateStudentBoxes) return { pageNumbers, built: [] };
  const firstPage = new Map();
  for (const page of pages.rows) {
    const pageNo = Number(page.page_no || 1);
    if (!firstPage.has(pageNo)) firstPage.set(pageNo, page);
  }
  const existing = await client.query("SELECT page_no FROM page_layout_templates WHERE exam_id = $1", [record.exam_id]);
  const templated = new Set(existing.rows.map((row) => Number(row.page_no)));
  const built = [];
  for (const pageNo of pageNumbers) {
    if (templated.has(pageNo) && !force) continue;
    const page = firstPage.get(pageNo);
    const image = await loadDeskPageImage(client, page.id);
    if (!image) continue;
    let boxes = null;
    try {
      boxes = await locateStudentBoxes(bufferToDataUrl(image.mime_type, image.image_data), structure);
    } catch (error) {
      console.error(`Page template locate failed (page ${pageNo}):`, error?.message || error);
    }
    const regions = boxes ? await buildRegionsFromBoxes({ image: image.image_data, questions: structure, boxes }) : [];
    const prepared = await preparePageImage(image.image_data);
    const frame = frameFromBounds(await analyzeContentBounds(prepared.buffer));
    await client.query(`INSERT INTO page_layout_templates
      (id, exam_id, page_no, source_page_id, width, height, frame, regions, method)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
      ON CONFLICT (exam_id, page_no) DO UPDATE SET source_page_id = EXCLUDED.source_page_id,
        width = EXCLUDED.width, height = EXCLUDED.height, frame = EXCLUDED.frame,
        regions = EXCLUDED.regions, method = EXCLUDED.method, updated_at = now()`,
    [randomUUID(), record.exam_id, pageNo, page.id, prepared.width || 0, prepared.height || 0,
      JSON.stringify(frame || {}), JSON.stringify(regions), boxes ? "ai" : "failed"]);
    built.push(pageNo);
  }
  return { pageNumbers, built };
}

// Builds one visual template per page (first captured paper only) and runs the
// local preflight for every student page. AI is only used when a template is
// missing or the teacher explicitly asks to relocate a page.
async function preflightDeskBatch(payload, account, locateStudentBoxes = null) {
  const force = payload.force === true;
  const record = await deskRecord(getPool(), payload.examId, account);
  const client = await getPool().connect();
  try {
    const structure = await getExamStructure(client, record.exam_id);
    const { pageNumbers, built } = await buildDeskPageTemplates(client, record, structure, locateStudentBoxes, force);
    const templates = await client.query("SELECT * FROM page_layout_templates WHERE exam_id = $1", [record.exam_id]);
    const templateMap = new Map(templates.rows.map((row) => [Number(row.page_no), {
      frame: row.frame, regions: asJsonArray(row.regions),
    }]));
    const pages = await client.query(`SELECT p.id, p.student_id, p.page_no, p.capture_order,
      COALESCE(r.status, '') AS region_status
      FROM scanned_pages p LEFT JOIN student_page_regions r ON r.scanned_page_id = p.id
      WHERE p.batch_id = $1 ORDER BY p.capture_order, p.page_no`, [record.batch_id]);
    const summary = [];
    for (const page of pages.rows) {
      const pageNo = Number(page.page_no || 1);
      if (!force && page.region_status === "manual") {
        summary.push({ pageId: page.id, studentId: page.student_id, pageNo, status: "manual" });
        continue;
      }
      const image = await loadDeskPageImage(client, page.id);
      if (!image) continue;
      const preflight = await preflightPage({ image: image.image_data, template: templateMap.get(pageNo) });
      await upsertStudentPageRegions(client, {
        batchId: record.batch_id, studentId: page.student_id, pageId: page.id, pageNo,
        regions: preflight.regions, align: { confidence: preflight.confidence, issue: preflight.issue, method: "local" },
        status: preflight.status,
      });
      summary.push({ pageId: page.id, studentId: page.student_id, pageNo, status: preflight.status,
        confidence: preflight.confidence, issue: preflight.issue });
    }
    return {
      pageNumbers, built,
      invalid: summary.filter((item) => item.status === "invalid").length,
      check: summary.filter((item) => item.status === "check").length,
      pages: summary,
    };
  } finally {
    client.release();
  }
}

async function relocateDeskStudentPage(payload, account, locateStudentBoxes) {
  const studentId = deskId(payload.studentId, "学生ID");
  const pageNo = Number(payload.pageNo || 1);
  if (!locateStudentBoxes) throw deskError("服务端未配置视觉定位能力。", 503);
  const record = await deskRecord(getPool(), payload.examId, account);
  if (!record.student_order_snapshot.some((student) => student.id === studentId)) {
    throw forbiddenError("学生不在本作业名单中。");
  }
  const page = await getPool().query(`SELECT id FROM scanned_pages WHERE batch_id = $1 AND student_id = $2 AND page_no = $3`,
    [record.batch_id, studentId, pageNo]);
  if (!page.rowCount) throw deskError("该学生此页尚未拍摄。", 400);
  const image = await loadDeskPageImage(getPool(), page.rows[0].id);
  const structure = await getExamStructure(getPool(), record.exam_id);
  const boxes = await locateStudentBoxes(bufferToDataUrl(image.mime_type, image.image_data), structure);
  const regions = boxes ? await buildRegionsFromBoxes({ image: image.image_data, questions: structure, boxes }) : [];
  const status = boxes ? "ok" : "invalid";
  await upsertStudentPageRegions(getPool(), {
    batchId: record.batch_id, studentId, pageId: page.rows[0].id, pageNo, regions,
    align: { confidence: boxes ? 1 : 0, issue: boxes ? "" : "视觉定位失败，请手动拖框", method: "ai" }, status,
  });
  return { status, regions };
}

async function saveDeskRegions(payload, account) {
  const studentId = deskId(payload.studentId, "学生ID");
  const pageNo = Number(payload.pageNo || 1);
  const incoming = Array.isArray(payload.regions) ? payload.regions : [];
  const record = await deskRecord(getPool(), payload.examId, account);
  if (!record.student_order_snapshot.some((student) => student.id === studentId)) {
    throw forbiddenError("学生不在本作业名单中。");
  }
  const page = await getPool().query(`SELECT id FROM scanned_pages WHERE batch_id = $1 AND student_id = $2 AND page_no = $3`,
    [record.batch_id, studentId, pageNo]);
  if (!page.rowCount) throw deskError("该学生此页尚未拍摄。", 400);
  const structure = await getExamStructure(getPool(), record.exam_id);
  const byQuestion = new Map(incoming.map((region) => [region.questionId, region]));
  const regions = structure.map((question) => {
    const source = byQuestion.get(question.id);
    const subs = new Map((source?.subs || []).map((sub) => [sub.subId, sub]));
    return {
      questionId: question.id, questionNo: question.questionNo,
      bbox: deskResultBBox(source?.bbox),
      subs: question.subs.map((sub) => ({
        subId: sub.id, label: sub.label,
        bbox: deskResultBBox(subs.get(sub.id)?.bbox),
      })),
    };
  }).filter((region) => region.bbox);
  await upsertStudentPageRegions(getPool(), {
    batchId: record.batch_id, studentId, pageId: page.rows[0].id, pageNo, regions,
    align: { confidence: 1, issue: "", method: "manual" }, status: "manual",
  });
  return { count: regions.length };
}

function deskQuestionTasks(structure) {
  const tasks = [];
  let objective = [];
  const flushObjective = () => {
    if (!objective.length) return;
    tasks.push({ kind: "objective", questions: objective });
    objective = [];
  };
  for (const question of structure) {
    if (isObjectiveQuestion(question.questionType)) {
      objective.push(question);
      if (objective.length === 3) flushObjective();
    } else {
      flushObjective();
      tasks.push({ kind: "written", questions: [question] });
    }
  }
  flushObjective();
  return tasks;
}

async function startDeskGrading(payload, account) {
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    if (record.grading_started_at) return {}; // Never enqueue twice, including after completion/failure.
    const pages = await client.query(`SELECT id, student_id, page_no, capture_order FROM scanned_pages
      WHERE batch_id = $1 ORDER BY capture_order, page_no`, [record.batch_id]);
    if (record.confirmed_version === null || record.confirmed_version !== record.capture_version ||
        !exactDeskPages(record.confirmed_page_ids, pages.rows.map((p) => p.id))) {
      throw deskError("请先确认当前全部照片和题目。", 409);
    }
    const invalid = await client.query(
      "SELECT COUNT(*) AS count FROM student_page_regions WHERE batch_id = $1 AND status = 'invalid'",
      [record.batch_id]);
    if (Number(invalid.rows[0]?.count || 0) > 0) {
      throw deskError(`有 ${invalid.rows[0].count} 页自动定位异常，请先在核对页校正框。`, 409);
    }
    const structure = await getExamStructure(client, record.exam_id);
    validateDeskQuestions(structure.map((q) => ({
      questionNo: q.questionNo, title: q.title, maxScore: q.maxScore,
      questionType: q.questionType, subs: q.subs.map((sub) => ({ label: sub.label, maxScore: sub.maxScore })),
    })));
    const pagesPerStudent = Math.max(1, Math.min(4, Number(record.pages_per_student) || 1));
    const pagesByStudent = new Map();
    for (const page of pages.rows) {
      if (!pagesByStudent.has(page.student_id)) pagesByStudent.set(page.student_id, []);
      pagesByStudent.get(page.student_id).push(page);
    }
    const partial = record.student_order_snapshot.filter((student) => {
      const count = pagesByStudent.get(student.id)?.length || 0;
      return count > 0 && count < pagesPerStudent;
    });
    if (partial.length) {
      throw deskError(`${partial.map((student) => student.name).join("、")} 的页面不完整，请补齐 ${pagesPerStudent} 页。`, 409);
    }
    const regions = await client.query(
      "SELECT student_id, scanned_page_id, page_no, regions FROM student_page_regions WHERE batch_id = $1",
      [record.batch_id]);
    const regionsByStudent = new Map();
    for (const row of regions.rows) {
      if (!regionsByStudent.has(row.student_id)) regionsByStudent.set(row.student_id, []);
      regionsByStudent.get(row.student_id).push(row);
    }
    const tasks = deskQuestionTasks(structure);
    if (!tasks.length) throw deskError("题目清单为空。", 409);
    for (const student of record.student_order_snapshot) {
      const studentPages = pagesByStudent.get(student.id) || [];
      if (!studentPages.length) continue;
      const pageIds = studentPages.map((page) => page.id);
      const studentRegions = regionsByStudent.get(student.id) || [];
      const pageForQuestion = new Map();
      for (const regionRow of studentRegions) {
        for (const region of asJsonArray(regionRow.regions)) {
          if (region?.questionId && region.bbox) pageForQuestion.set(region.questionId, regionRow.scanned_page_id);
        }
      }
      for (const [index, task] of tasks.entries()) {
        const taskPageIds = [...new Set(task.questions.map((question) => pageForQuestion.get(question.id)).filter(Boolean))];
        await client.query(`INSERT INTO grading_jobs
          (id, batch_id, student_id, task_no, job_kind, page_ids, question_ids)
          VALUES ($1, $2, $3, $4, 'paper_group', $5::jsonb, $6::jsonb)
          ON CONFLICT (batch_id, student_id, task_no) WHERE job_kind = 'paper_group' DO NOTHING`,
        [randomUUID(), record.batch_id, student.id, index + 1,
          JSON.stringify(taskPageIds.length ? taskPageIds : pageIds),
          JSON.stringify(task.questions.map((question) => question.id))]);
      }
    }
    await client.query("UPDATE scan_batches SET status = 'grading', grading_started_at = now() WHERE id = $1", [record.batch_id]);
    return {};
  });
}

async function retryDeskGrading(payload, account) {
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    if (!record.grading_started_at) throw deskError("尚未开始批改。", 409);
    const retried = await client.query(`UPDATE grading_jobs SET status = 'pending', error = '', finished_at = NULL,
      lease_token = NULL, lease_expires_at = NULL
      WHERE batch_id = $1 AND job_kind IN ('whole_paper', 'paper_group') AND status = 'failed' AND attempts < $2 RETURNING id`, [record.batch_id, DESK_MAX_ATTEMPTS]);
    if (!retried.rowCount) {
      const exhausted = await client.query("SELECT id FROM grading_jobs WHERE batch_id = $1 AND job_kind IN ('whole_paper', 'paper_group') AND status = 'failed'", [record.batch_id]);
      if (exhausted.rowCount) throw deskError("失败任务已达到最多 3 次尝试，不能继续重试。", 409);
    }
    await settleDeskBatch(client, record.batch_id);
    return {};
  });
}

async function listDeskAssignments(account) {
  const result = await getPool().query(`
    SELECT e.id, e.name, c.name AS class_name, to_char(e.exam_date, 'YYYY-MM-DD') AS exam_date,
      b.id AS batch_id, b.status, jsonb_array_length(e.student_order_snapshot) AS student_count,
      b.pages_per_student,
      (SELECT COUNT(*) FROM scanned_pages p WHERE p.batch_id = b.id) AS captured_count,
      (
        (SELECT COUNT(*) FROM (
          SELECT j.student_id FROM grading_jobs j
          WHERE j.batch_id = b.id AND j.job_kind = 'paper_group'
          GROUP BY j.student_id
          HAVING COUNT(*) FILTER (WHERE j.status <> 'done') = 0
        ) grouped)
        + (SELECT COUNT(*) FROM grading_jobs j WHERE j.batch_id = b.id AND j.job_kind = 'whole_paper' AND j.status = 'done')
      ) AS done_count,
      (SELECT COUNT(*) FROM grading_results r WHERE r.batch_id = b.id AND (r.needs_review OR EXISTS (
        SELECT 1 FROM grading_sub_results gs WHERE gs.result_id = r.id AND gs.needs_review AND NOT gs.reviewed
      ))) AS review_count,
      (SELECT AVG(t.score) FROM (SELECT SUM(COALESCE(r.final_score, r.score)) AS score FROM grading_results r
        JOIN grading_jobs j ON j.id = r.job_id AND j.status = 'done'
        WHERE r.batch_id = b.id GROUP BY r.student_id) t) AS average_score
    FROM exams e JOIN scan_batches b ON b.exam_id = e.id AND b.desk_managed
    LEFT JOIN classes c ON c.id = e.class_id
    WHERE e.teacher_account = $1 AND e.desk_managed ORDER BY e.created_at DESC
  `, [deskAccount(account)]);
  return { assignments: result.rows.map((r) => ({
    id: r.id, name: r.name, className: r.class_name || "", examDate: r.exam_date,
    batchId: r.batch_id, status: r.status, studentCount: Number(r.student_count),
    pagesPerStudent: Math.max(1, Math.min(4, Number(r.pages_per_student) || 1)),
    capturedCount: Number(r.captured_count), doneCount: Number(r.done_count), reviewCount: Number(r.review_count),
    averageScore: r.average_score === null ? null : Number(r.average_score),
  })) };
}

function deskResultBBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x, y, width, height] = value.map(Number);
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x >= 1 || y >= 1 || x + width > 1.001 || y + height > 1.001) {
    return null;
  }
  return [x, y, width, height];
}

async function getDeskDetail(examId, account) {
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, examId, account);
    const pages = await client.query(`SELECT p.id, p.student_id, p.capture_order, p.page_no,
      COALESCE(NULLIF(g.status, ''), NULLIF(w.status, ''), 'captured') AS status,
      COALESCE(NULLIF(g.error, ''), w.error, '') AS error,
      COALESCE(r.status, '') AS region_status,
      COALESCE(r.align->>'issue', '') AS region_issue,
      r.align->>'confidence' AS region_confidence
      FROM scanned_pages p
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0 THEN 'failed'
          WHEN COUNT(*) FILTER (WHERE status IN ('pending', 'running')) > 0 THEN 'grading'
          WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE status = 'done') = COUNT(*) THEN 'done'
          ELSE '' END AS status,
          COALESCE(MAX(error) FILTER (WHERE status = 'failed'), '') AS error
        FROM grading_jobs
        WHERE batch_id = p.batch_id AND student_id = p.student_id AND job_kind = 'paper_group'
      ) g ON true
      LEFT JOIN LATERAL (
        SELECT status, error FROM grading_jobs
        WHERE scanned_page_id = p.id AND job_kind = 'whole_paper' LIMIT 1
      ) w ON true
      LEFT JOIN student_page_regions r ON r.scanned_page_id = p.id
      WHERE p.batch_id = $1 ORDER BY p.capture_order, p.page_no`, [record.batch_id]);
    const questions = await client.query(`SELECT q.id, q.question_no, q.max_score, q.title, q.question_type,
      COALESCE(json_agg(json_build_object('id', s.id, 'label', s.label, 'maxScore', s.max_score, 'ordinal', s.ordinal)
        ORDER BY s.ordinal) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS subs
      FROM exam_questions q LEFT JOIN exam_sub_questions s ON s.question_id = q.id
      WHERE q.exam_id = $1 GROUP BY q.id ORDER BY q.created_at, q.question_no`, [record.exam_id]);
    const results = await client.query(`SELECT r.*, q.question_no, q.question_type FROM grading_results r
      JOIN exam_questions q ON q.id = r.question_id WHERE r.batch_id = $1 ORDER BY q.created_at, q.question_no`, [record.batch_id]);
    const subs = await client.query(`SELECT * FROM grading_sub_results WHERE batch_id = $1 ORDER BY created_at ASC`, [record.batch_id]);
    const subsByResult = new Map();
    for (const sub of subs.rows) {
      if (!subsByResult.has(sub.result_id)) subsByResult.set(sub.result_id, []);
      subsByResult.get(sub.result_id).push({
        id: sub.id, subQuestionId: sub.sub_question_id, label: sub.label,
        score: sub.final_score === null ? (sub.score === null ? null : Number(sub.score)) : Number(sub.final_score),
        rawScore: sub.score === null ? null : Number(sub.score),
        maxScore: Number(sub.max_score), correct: sub.correct, studentAnswer: sub.student_answer,
        analysis: sub.analysis, needsReview: sub.needs_review, reviewed: sub.reviewed,
        confidence: sub.confidence === null ? null : Number(sub.confidence),
      });
    }
    return {
      exam: { id: record.exam_id, name: record.name },
      batch: { id: record.batch_id, status: record.status, pagesPerStudent: Math.max(1, Number(record.pages_per_student) || 1) },
      students: record.student_order_snapshot,
      pages: pages.rows.map((p) => ({
        id: p.id, studentId: p.student_id, captureOrder: p.capture_order, pageNo: Number(p.page_no || 1),
        status: p.status, error: p.error, regionStatus: p.region_status, regionIssue: p.region_issue,
        regionConfidence: p.region_confidence === null ? null : Number(p.region_confidence),
      })),
      questions: questions.rows.map((q) => ({
        id: q.id, questionNo: q.question_no, maxScore: Number(q.max_score), title: q.title,
        questionType: q.question_type || "",
        subQuestions: asJsonArray(q.subs).map((sub) => ({
          id: sub.id, label: sub.label || "", maxScore: Number(sub.maxScore), ordinal: Number(sub.ordinal) || 0,
        })),
      })),
      results: results.rows.map((r) => {
        const subRows = subsByResult.get(r.id) || [];
        const subTotal = subRows.length && subRows.every((sub) => sub.score !== null)
          ? subRows.reduce((sum, sub) => sum + sub.score, 0) : null;
        return {
          studentId: r.student_id, questionId: r.question_id, questionNo: r.question_no,
          score: Number(subTotal ?? r.final_score ?? r.score), maxScore: Number(r.max_score), analysis: r.analysis,
          suggestions: asJsonArray(r.suggestions), knowledgePoints: asJsonArray(r.ai_result?.knowledge_points),
          needsReview: r.needs_review || subRows.some((sub) => sub.needsReview && !sub.reviewed),
          bbox: deskResultBBox(r.ai_result?.bbox), subs: subRows,
        };
      }),
    };
  }, true);
}

async function refinedStudentBoxes(client, batchId, studentId, imageBuffer) {
  const rows = await client.query(`SELECT q.question_no, r.ai_result->'bbox' AS bbox
    FROM grading_results r JOIN exam_questions q ON q.id = r.question_id
    WHERE r.batch_id = $1 AND r.student_id = $2 ORDER BY q.created_at, q.question_no`, [batchId, studentId]);
  if (!rows.rowCount) return {};
  const entries = rows.rows.map((row) => ({ questionNo: row.question_no, bbox: deskResultBBox(row.bbox) }));
  let positioned = entries;
  try {
    positioned = alignBoxes(entries, await analyzeAnswerLayout(imageBuffer)) || entries;
  } catch {
    positioned = entries;
  }
  return Object.fromEntries(positioned.filter((entry) => entry.bbox).map((entry) => [entry.questionNo, entry.bbox]));
}

async function getDeskImage(examId, studentId, account, thumbnail = false, preview = false, withBoxes = false, pageNo = 1) {
  studentId = deskId(studentId, "学生ID");
  const requestedPage = Number.isInteger(Number(pageNo)) && Number(pageNo) > 0 ? Number(pageNo) : 1;
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, examId, account);
    if (!record.student_order_snapshot.some((s) => s.id === studentId)) throw forbiddenError("学生不在本作业名单中。");
    const image = await client.query(`SELECT p.id, p.page_no, i.mime_type, i.image_data FROM scanned_pages p
      JOIN uploaded_images i ON i.id = p.image_id
      WHERE p.batch_id = $1 AND p.student_id = $2 AND p.page_no = $3`, [record.batch_id, studentId, requestedPage]);
    if (!image.rowCount) throw deskError("该学生尚未拍摄此页照片。", 400);
    if (thumbnail) {
      const thumbnailBuffer = await sharp(image.rows[0].image_data).rotate().resize({ width: 240, height: 320, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
      return { image: bufferToDataUrl("image/jpeg", thumbnailBuffer), pageNo: requestedPage };
    }
    const buffer = preview
      ? await sharp(image.rows[0].image_data).rotate().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
      : image.rows[0].image_data;
    let boxes = null, regions = null;
    if (withBoxes) {
      const stored = await client.query("SELECT regions FROM student_page_regions WHERE scanned_page_id = $1", [image.rows[0].id]);
      const storedRegions = stored.rowCount ? asJsonArray(stored.rows[0].regions).filter((region) => region?.bbox) : [];
      if (storedRegions.length) {
        regions = storedRegions;
        boxes = Object.fromEntries(storedRegions.map((region) => [region.questionNo, region.bbox]));
      } else {
        boxes = await refinedStudentBoxes(client, record.batch_id, studentId, buffer);
      }
    }
    return {
      image: bufferToDataUrl(preview ? "image/jpeg" : image.rows[0].mime_type, buffer),
      pageNo: requestedPage,
      ...(withBoxes ? { boxes, regions } : {}),
    };
  }, true);
}

async function getDeskAnswerImage(examId, account) {
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, examId, account);
    if (!record.answer_image_id) return { image: "" };
    const image = await client.query("SELECT mime_type, image_data FROM uploaded_images WHERE id = $1", [record.answer_image_id]);
    if (!image.rowCount) return { image: "" };
    const preview = await sharp(image.rows[0].image_data).rotate().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { image: bufferToDataUrl("image/jpeg", preview) };
  }, true);
}

async function assertLegacyMutationAllowed(action, payload, account) {
  const targets = {
    "create-question": [["examId", "exams", "id"]], "create-template": [["examId", "exams", "id"]],
    "create-batch": [["examId", "exams", "id"]], "grade-student": [["examId", "exams", "id"]],
    "upload-page": [["batchId", "scan_batches", "exam_id"]], "process-batch": [["batchId", "scan_batches", "exam_id"]],
    "grade-next": [["batchId", "scan_batches", "exam_id"]], "analyze-batch": [["batchId", "scan_batches", "exam_id"]],
    "save-region": [["templateId", "paper_templates", "exam_id"], ["questionId", "exam_questions", "exam_id"]],
  };
  for (const [field, table, column] of targets[action] || []) {
    const id = deskId(payload[field], field);
    const result = await getPool().query(`SELECT e.desk_managed FROM ${table} t JOIN exams e ON e.id = t.${column}
      WHERE t.id = $1 AND e.teacher_account = $2`, [id, deskAccount(account)]);
    if (!result.rowCount) throw forbiddenError("资源不存在或无权访问。");
    if (result.rows[0].desk_managed) throw deskError("此作业由批改台管理，请使用 desk 接口。", 409);
  }
}

async function settleDeskBatch(client, batchId) {
  // Caller holds the batch lock, so concurrent completions cannot leave it in grading forever.
  await client.query(`UPDATE scan_batches b SET status = CASE
    WHEN EXISTS (SELECT 1 FROM grading_jobs j WHERE j.batch_id = b.id AND j.status IN ('pending', 'running')) THEN 'grading'
    WHEN EXISTS (SELECT 1 FROM grading_jobs j WHERE j.batch_id = b.id AND j.status = 'failed') THEN 'failed'
    WHEN EXISTS (SELECT 1 FROM grading_results r WHERE r.batch_id = b.id AND (r.needs_review OR EXISTS (
      SELECT 1 FROM grading_sub_results gs WHERE gs.result_id = r.id AND gs.needs_review AND NOT gs.reviewed
    ))) THEN 'needs_review'
    ELSE 'done' END WHERE b.id = $1 AND b.desk_managed`, [batchId]);
}

async function touchWorkerHeartbeat(name = "whole-paper") {
  await getPool().query(`INSERT INTO worker_heartbeats (name, last_seen_at) VALUES ($1, now())
    ON CONFLICT (name) DO UPDATE SET last_seen_at = now()`, [name]);
}

async function isWorkerHeartbeatFresh(name = "whole-paper") {
  const result = await getPool().query(
    `SELECT last_seen_at > now() - interval '90 seconds' AS fresh FROM worker_heartbeats WHERE name = $1`,
    [name]);
  return Boolean(result.rows[0]?.fresh);
}

async function recoverWholePaperJobs() {
  return deskTransaction(async (client) => {
    const batches = await client.query(`SELECT b.id FROM scan_batches b WHERE b.desk_managed AND EXISTS (
      SELECT 1 FROM grading_jobs j WHERE j.batch_id = b.id AND j.job_kind = 'whole_paper'
        AND j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= now()))
      ORDER BY b.created_at LIMIT 20 FOR UPDATE OF b SKIP LOCKED`);
    for (const batch of batches.rows) {
      await client.query(`UPDATE grading_jobs SET status = CASE WHEN attempts < $2 THEN 'pending' ELSE 'failed' END,
        error = '工作进程中断或租约过期', lease_token = NULL, lease_expires_at = NULL,
        finished_at = CASE WHEN attempts < $2 THEN NULL ELSE now() END
        WHERE batch_id = $1 AND job_kind = 'whole_paper' AND status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())`, [batch.id, DESK_MAX_ATTEMPTS]);
      await settleDeskBatch(client, batch.id);
    }
  });
}

async function claimWholePaperJob() {
  return deskTransaction(async (client) => {
    const batches = await client.query(`SELECT b.id FROM scan_batches b WHERE b.desk_managed AND b.grading_started_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM grading_jobs j WHERE j.batch_id = b.id AND j.job_kind = 'whole_paper'
        AND j.status = 'pending' AND j.attempts < $1)
      ORDER BY b.created_at LIMIT 1 FOR UPDATE OF b SKIP LOCKED`, [DESK_MAX_ATTEMPTS]);
    if (!batches.rowCount) return null;
    const jobs = await client.query(`SELECT id FROM grading_jobs WHERE batch_id = $1 AND job_kind = 'whole_paper'
      AND status = 'pending' AND attempts < $2 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [batches.rows[0].id, DESK_MAX_ATTEMPTS]);
    if (!jobs.rowCount) return null;
    const token = randomUUID();
    const result = await client.query(`UPDATE grading_jobs SET status = 'running', attempts = attempts + 1,
      error = '', started_at = now(), finished_at = NULL, lease_token = $2,
      lease_expires_at = now() + $3 * interval '1 second' WHERE id = $1 RETURNING id, batch_id`, [jobs.rows[0].id, token, DESK_LEASE_SECONDS]);
    await client.query("UPDATE scan_batches SET status = 'grading' WHERE id = $1", [batches.rows[0].id]);
    return { id: result.rows[0].id, batchId: result.rows[0].batch_id, leaseToken: token };
  });
}

async function renewWholePaperLease(job) {
  const result = await getPool().query(`UPDATE grading_jobs SET lease_expires_at = now() + $3 * interval '1 second'
    WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > now()`, [job.id, job.leaseToken, DESK_LEASE_SECONDS]);
  return result.rowCount > 0;
}

async function claimPaperGroupJobs(limit = 6, perStudent = 2) {
  const take = Math.max(1, Math.min(12, Number(limit) || 6));
  const per = Math.max(1, Math.min(4, Number(perStudent) || 2));
  return deskTransaction(async (client) => {
    const candidates = await client.query(`
      WITH running AS (
        SELECT batch_id, student_id, COUNT(*) AS count FROM grading_jobs
        WHERE job_kind = 'paper_group' AND status = 'running'
        GROUP BY batch_id, student_id
      ), ranked AS (
        SELECT j.id, j.batch_id, j.student_id, j.created_at,
          ROW_NUMBER() OVER (PARTITION BY j.batch_id, j.student_id ORDER BY j.created_at, j.id) AS rn
        FROM grading_jobs j
        JOIN scan_batches b ON b.id = j.batch_id AND b.desk_managed AND b.grading_started_at IS NOT NULL
        WHERE j.job_kind = 'paper_group' AND j.status = 'pending' AND j.attempts < $1
      )
      SELECT j.id, j.batch_id, j.student_id
      FROM grading_jobs j
      JOIN ranked r ON r.id = j.id
      LEFT JOIN running u ON u.batch_id = j.batch_id AND u.student_id = j.student_id
      WHERE r.rn <= $2 - COALESCE(u.count, 0)
      ORDER BY r.created_at, r.id
      LIMIT $3
      FOR UPDATE OF j SKIP LOCKED`, [DESK_MAX_ATTEMPTS, per, take]);
    const claimed = [];
    const batches = new Set();
    for (const row of candidates.rows) {
      const token = randomUUID();
      const result = await client.query(`UPDATE grading_jobs SET status = 'running', attempts = attempts + 1,
        error = '', started_at = now(), finished_at = NULL, lease_token = $2,
        lease_expires_at = now() + $3 * interval '1 second' WHERE id = $1 RETURNING id, batch_id, student_id`,
      [row.id, token, DESK_LEASE_SECONDS]);
      if (result.rowCount) {
        claimed.push({ id: result.rows[0].id, batchId: result.rows[0].batch_id,
          studentId: result.rows[0].student_id, leaseToken: token });
        batches.add(result.rows[0].batch_id);
      }
    }
    for (const batchId of batches) {
      await client.query("UPDATE scan_batches SET status = 'grading' WHERE id = $1", [batchId]);
    }
    return claimed;
  });
}

async function renewPaperGroupLease(job) {
  const result = await getPool().query(`UPDATE grading_jobs SET lease_expires_at = now() + $3 * interval '1 second'
    WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > now()`,
  [job.id, job.leaseToken, DESK_LEASE_SECONDS]);
  return result.rowCount > 0;
}

async function recoverPaperGroupJobs() {
  return deskTransaction(async (client) => {
    const batches = await client.query(`SELECT batch_id FROM (
      SELECT batch_id, created_at FROM grading_jobs
      WHERE job_kind = 'paper_group' AND status = 'running'
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY created_at LIMIT 40 FOR UPDATE SKIP LOCKED
    ) expired GROUP BY batch_id LIMIT 20`);
    for (const batch of batches.rows) {
      await client.query(`UPDATE grading_jobs SET status = CASE WHEN attempts < $2 THEN 'pending' ELSE 'failed' END,
        error = '工作进程中断或租约过期', lease_token = NULL, lease_expires_at = NULL,
        finished_at = CASE WHEN attempts < $2 THEN NULL ELSE now() END
        WHERE batch_id = $1 AND job_kind = 'paper_group' AND status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())`, [batch.batch_id, DESK_MAX_ATTEMPTS]);
      await settleDeskBatch(client, batch.batch_id);
    }
  });
}

function imageDataUrl(row) {
  return row?.image_data ? bufferToDataUrl(row.mime_type || "image/jpeg", row.image_data) : "";
}

async function getPaperGroupJobPayload(job) {
  const result = await getPool().query(`SELECT j.page_ids, j.question_ids, j.student_id, j.batch_id,
    b.exam_id, e.name, e.answer_image_id
    FROM grading_jobs j
    JOIN scan_batches b ON b.id = j.batch_id AND b.desk_managed
    JOIN exams e ON e.id = b.exam_id
    WHERE j.id = $1 AND j.lease_token = $2 AND j.status = 'running' AND j.lease_expires_at > now()`,
  [job.id, job.leaseToken]);
  if (!result.rowCount) throw deskError("任务租约已失效或图片不存在。", 409);
  const row = result.rows[0];
  const questionIds = asJsonArray(row.question_ids);
  const pageIds = asJsonArray(row.page_ids);
  const structure = (await getExamStructure(getPool(), row.exam_id)).filter((question) => questionIds.includes(question.id));
  if (!structure.length) throw deskError("任务没有可批改的题目。", 409);

  const crops = await getPool().query(`
    SELECT q.id AS ref_id, 'question' AS source, i.mime_type, i.image_data
    FROM exam_questions q JOIN uploaded_images i ON i.id = q.answer_crop_image_id
    WHERE q.id = ANY($1::uuid[])
    UNION ALL
    SELECT s.question_id AS ref_id, 'sub' AS source, i.mime_type, i.image_data
    FROM exam_sub_questions s JOIN uploaded_images i ON i.id = s.answer_crop_image_id
    WHERE s.question_id = ANY($1::uuid[])`, [questionIds]);
  const questionCrop = new Map();
  const subCrop = new Map();
  for (const crop of crops.rows) {
    if (crop.source === "question") questionCrop.set(crop.ref_id, imageDataUrl(crop));
    else subCrop.set(crop.ref_id, imageDataUrl(crop));
  }
  const answer = row.answer_image_id
    ? await getPool().query("SELECT mime_type, image_data FROM uploaded_images WHERE id = $1", [row.answer_image_id])
    : { rows: [] };
  const answerImage = imageDataUrl(answer.rows[0]);

  const pages = await getPool().query(`SELECT p.id, p.page_no, i.mime_type, i.image_data
    FROM scanned_pages p JOIN uploaded_images i ON i.id = p.image_id
    WHERE p.id = ANY($1::uuid[]) AND p.student_id = $2 ORDER BY p.page_no`, [pageIds, row.student_id]);
  if (!pages.rowCount) throw deskError("学生页面已删除，无法批改。", 409);
  const preparedPages = new Map();
  for (const page of pages.rows) preparedPages.set(page.id, await preparePageImage(page.image_data));
  const fullPage = imageDataUrl(pages.rows[0]);

  const regions = await getPool().query(`SELECT scanned_page_id, page_no, regions FROM student_page_regions
    WHERE batch_id = $1 AND student_id = $2`, [row.batch_id, row.student_id]);
  const regionByQuestion = new Map();
  for (const regionRow of regions.rows) {
    for (const region of asJsonArray(regionRow.regions)) {
      if (region?.questionId && region.bbox) {
        regionByQuestion.set(region.questionId, {
          pageId: regionRow.scanned_page_id, pageNo: Number(regionRow.page_no || 1), bbox: region.bbox,
        });
      }
    }
  }

  const questions = [];
  for (const question of structure) {
    const region = regionByQuestion.get(question.id);
    const prepared = region ? preparedPages.get(region.pageId) : null;
    const studentCrop = prepared ? await cropRegionDataUrl(prepared, region.bbox) : "";
    questions.push({
      questionId: question.id, questionNo: question.questionNo, title: question.title,
      maxScore: question.maxScore, questionType: question.questionType,
      subs: question.subs.map((sub) => ({ id: sub.id, label: sub.label, maxScore: sub.maxScore })),
      answerImage: questionCrop.get(question.id) || (question.subs.length === 1 ? subCrop.get(question.id) : "") || answerImage,
      studentImage: studentCrop || fullPage,
    });
  }
  for (const question of questions) {
    if (!question.answerImage || !question.studentImage) {
      throw deskError(`题目 ${question.questionNo} 缺少答案或作答图片。`, 409);
    }
  }
  const objective = questions.every((question) => isObjectiveQuestion(question.questionType));
  return { examName: row.name, kind: objective ? "objective" : "written", questions };
}

async function lockPaperGroupJob(client, job) {
  await client.query("SELECT id FROM scan_batches WHERE id = $1 AND desk_managed FOR UPDATE", [job.batchId]);
  const result = await client.query(`SELECT j.*, b.exam_id FROM grading_jobs j
    JOIN scan_batches b ON b.id = j.batch_id AND b.desk_managed
    WHERE j.id = $1 AND j.batch_id = $2 AND j.lease_token = $3 AND j.job_kind = 'paper_group'
      AND j.status = 'running' AND j.lease_expires_at > now() FOR UPDATE OF j`,
  [job.id, job.batchId, job.leaseToken]);
  return result.rows[0] || null;
}

async function completePaperGroupJob(job, grade) {
  return deskTransaction(async (client) => {
    const row = await lockPaperGroupJob(client, job);
    if (!row) return false;
    const questionIds = asJsonArray(row.question_ids);
    const structure = (await getExamStructure(client, row.exam_id)).filter((question) => questionIds.includes(question.id));
    const expected = structure.map((question) => ({
      questionNo: question.questionNo, title: question.title, maxScore: question.maxScore,
      questionType: question.questionType,
      subs: question.subs.map((sub) => ({ label: sub.label, maxScore: sub.maxScore })),
    }));
    const result = validateWholePaperResult(grade.result, expected);
    const byQuestionNo = new Map(structure.map((question) => [question.questionNo, question]));
    for (const item of result.questions) {
      const question = byQuestionNo.get(item.question_no);
      if (!question) continue;
      // Re-grading replaces the previous result and its sub rows.
      await client.query(`DELETE FROM grading_results WHERE batch_id = $1 AND student_id = $2 AND question_id = $3`,
        [job.batchId, row.student_id, question.id]);
      const inserted = await client.query(`INSERT INTO grading_results
        (id, job_id, batch_id, exam_id, student_id, question_id, score, max_score, analysis,
         suggestions, deductions, ai_result, confidence, needs_review)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
        RETURNING id`,
      [randomUUID(), job.id, job.batchId, row.exam_id, row.student_id, question.id, item.score, item.max_score,
        item.analysis, JSON.stringify(item.suggestions), JSON.stringify(item.deductions), JSON.stringify(item),
        item.confidence, item.needs_review]);
      const resultId = inserted.rows[0].id;
      const implicitSingle = question.subs.length === 1 && !question.subs[0].label;
      for (const [index, sub] of question.subs.entries()) {
        const part = implicitSingle
          ? { score: item.score, max_score: item.max_score, correct: item.score >= item.max_score - 0.001, student_answer: "" }
          : item.parts[index];
        const score = part && part.score !== null && part.score !== undefined ? Number(part.score) : null;
        await client.query(`INSERT INTO grading_sub_results
          (id, result_id, job_id, batch_id, student_id, question_id, sub_question_id, label,
           score, max_score, correct, student_answer, analysis, confidence, needs_review)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [randomUUID(), resultId, job.id, job.batchId, row.student_id, question.id, sub.id, sub.label || "",
          score, part ? part.max_score : sub.maxScore, part ? part.correct : false, part?.student_answer || "",
          "", item.confidence, item.needs_review || score === null]);
      }
    }
    await client.query(`UPDATE grading_jobs SET status = 'done', finished_at = now(), error = '',
      lease_token = NULL, lease_expires_at = NULL, overall_feedback = $2::jsonb WHERE id = $1`,
    [job.id, JSON.stringify({
      analysis: result.overall_analysis, suggestions: result.overall_suggestions, model: grade.model || "",
    })]);
    await settleDeskBatch(client, job.batchId);
    return true;
  });
}

async function failPaperGroupJob(job, message) {
  return deskTransaction(async (client) => {
    if (!(await lockPaperGroupJob(client, job))) return false;
    await client.query(`UPDATE grading_jobs SET status = 'failed', finished_at = now(), error = $2,
      lease_token = NULL, lease_expires_at = NULL WHERE id = $1`,
    [job.id, String(message || "评分失败。").slice(0, 1000)]);
    await settleDeskBatch(client, job.batchId);
    return true;
  });
}

async function saveDeskSubScore(payload, account) {
  const studentId = deskId(payload.studentId, "学生ID");
  const subResultId = deskId(payload.subResultId, "小题结果ID");
  const score = Number(payload.score);
  if (!Number.isFinite(score) || score < 0) throw deskError("分数必须为不小于 0 的数字。");
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    const row = await client.query(`SELECT gs.*, r.needs_review AS result_needs_review
      FROM grading_sub_results gs
      JOIN grading_results r ON r.id = gs.result_id
      JOIN exam_questions q ON q.id = gs.question_id
      WHERE gs.id = $1 AND gs.batch_id = $2 AND gs.student_id = $3 AND q.exam_id = $4
      FOR UPDATE OF gs`, [subResultId, record.batch_id, studentId, record.exam_id]);
    if (!row.rowCount) throw forbiddenError("小题结果不存在或无权访问。");
    const sub = row.rows[0];
    if (score > Number(sub.max_score) + 1e-9) throw deskError("分数不能超过该小题满分。");
    const finalScore = Math.round(score * 100) / 100;
    await client.query("UPDATE grading_sub_results SET final_score = $2, reviewed = true, needs_review = false WHERE id = $1",
      [subResultId, finalScore]);
    const totals = await client.query(`SELECT COALESCE(SUM(COALESCE(final_score, score, 0)), 0) AS total,
      BOOL_OR(needs_review AND NOT reviewed) AS pending FROM grading_sub_results WHERE result_id = $1`,
    [sub.result_id]);
    const total = Math.round(Number(totals.rows[0]?.total || 0) * 100) / 100;
    const pending = Boolean(totals.rows[0]?.pending);
    await client.query(`UPDATE grading_results SET score = $2, final_score = $2, needs_review = $3 WHERE id = $1`,
      [sub.result_id, total, pending]);
    await settleDeskBatch(client, record.batch_id);
    return { score: total, needsReview: pending };
  });
}

async function regradeDeskQuestion(payload, account) {
  const studentId = deskId(payload.studentId, "学生ID");
  const questionId = deskId(payload.questionId, "题目ID");
  return deskTransaction(async (client) => {
    const record = await deskRecord(client, payload.examId, account, true);
    if (!record.grading_started_at) throw deskError("尚未开始批改。", 409);
    if (!record.student_order_snapshot.some((student) => student.id === studentId)) {
      throw forbiddenError("学生不在本作业名单中。");
    }
    const question = await client.query("SELECT id FROM exam_questions WHERE id = $1 AND exam_id = $2", [questionId, record.exam_id]);
    if (!question.rowCount) throw forbiddenError("题目不存在或无权访问。");
    const next = await client.query(`SELECT COALESCE(MAX(task_no), 0) + 1 AS next FROM grading_jobs
      WHERE batch_id = $1 AND student_id = $2 AND job_kind = 'paper_group'`, [record.batch_id, studentId]);
    const pages = await client.query(`SELECT p.id, r.regions FROM scanned_pages p
      LEFT JOIN student_page_regions r ON r.scanned_page_id = p.id
      WHERE p.batch_id = $1 AND p.student_id = $2 ORDER BY p.page_no`, [record.batch_id, studentId]);
    if (!pages.rowCount) throw deskError("该学生尚未拍摄照片。", 409);
    const pageIds = [];
    for (const page of pages.rows) {
      if (asJsonArray(page.regions).some((region) => region?.questionId === questionId && region.bbox)) pageIds.push(page.id);
    }
    await client.query(`INSERT INTO grading_jobs
      (id, batch_id, student_id, task_no, job_kind, page_ids, question_ids)
      VALUES ($1, $2, $3, $4, 'paper_group', $5::jsonb, $6::jsonb)`,
    [randomUUID(), record.batch_id, studentId, Number(next.rows[0].next),
      JSON.stringify(pageIds.length ? pageIds : pages.rows.map((page) => page.id)), JSON.stringify([questionId])]);
    await client.query("UPDATE scan_batches SET status = 'grading' WHERE id = $1", [record.batch_id]);
    return {};
  });
}

async function getWholePaperJobPayload(job) {
  const result = await getPool().query(`SELECT e.name, e.id AS exam_id, p.student_id,
    answer.mime_type AS answer_mime, answer.image_data AS answer_data,
    student.mime_type AS student_mime, student.image_data AS student_data
    FROM grading_jobs j JOIN scan_batches b ON b.id = j.batch_id AND b.desk_managed
    JOIN exams e ON e.id = b.exam_id AND e.desk_managed
    JOIN scanned_pages p ON p.id = j.scanned_page_id AND p.batch_id = b.id
    JOIN uploaded_images answer ON answer.id = e.answer_image_id
    JOIN uploaded_images student ON student.id = p.image_id
    WHERE j.id = $1 AND j.lease_token = $2 AND j.status = 'running' AND j.lease_expires_at > now()`, [job.id, job.leaseToken]);
  if (!result.rowCount) throw deskError("任务租约已失效或图片不存在。", 409);
  const row = result.rows[0];
  const questions = await listExamQuestions(row.exam_id);
  return { examName: row.name, expectedQuestions: questions,
    teacherAnswerImage: bufferToDataUrl(row.answer_mime, row.answer_data),
    studentImage: bufferToDataUrl(row.student_mime, row.student_data) };
}

async function lockWholePaperJob(client, job) {
  await client.query("SELECT id FROM scan_batches WHERE id = $1 AND desk_managed FOR UPDATE", [job.batchId]);
  const result = await client.query(`SELECT j.*, p.student_id, b.exam_id FROM grading_jobs j
    JOIN scanned_pages p ON p.id = j.scanned_page_id JOIN scan_batches b ON b.id = j.batch_id
    WHERE j.id = $1 AND j.batch_id = $2 AND j.lease_token = $3 AND j.job_kind = 'whole_paper'
      AND j.status = 'running' AND j.lease_expires_at > now() FOR UPDATE OF j`, [job.id, job.batchId, job.leaseToken]);
  return result.rows[0] || null;
}

async function completeWholePaperJob(job, grade) {
  return deskTransaction(async (client) => {
    const row = await lockWholePaperJob(client, job);
    if (!row) return false; // Fencing: late/stale workers and duplicate completion cannot write.
    const expected = await client.query("SELECT id, question_no, title, max_score FROM exam_questions WHERE exam_id = $1", [row.exam_id]);
    const questions = expected.rows.map((q) => ({ id: q.id, questionNo: q.question_no, title: q.title, maxScore: Number(q.max_score) }));
    const result = validateWholePaperResult(grade.result, questions);
    const questionMap = new Map(questions.map((q) => [q.questionNo, q.id]));
    for (const item of result.questions) {
      await client.query(`INSERT INTO grading_results
        (id, job_id, batch_id, exam_id, student_id, question_id, score, max_score, analysis,
         suggestions, deductions, ai_result, confidence, needs_review)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
        ON CONFLICT (job_id, question_id) DO NOTHING`, [randomUUID(), job.id, job.batchId, row.exam_id, row.student_id,
        questionMap.get(item.question_no), item.score, item.max_score, item.analysis,
        JSON.stringify(item.suggestions), JSON.stringify(item.deductions), JSON.stringify(item), item.confidence, item.needs_review]);
    }
    await client.query(`UPDATE grading_jobs SET status = 'done', finished_at = now(), error = '',
      lease_token = NULL, lease_expires_at = NULL, overall_feedback = $2::jsonb WHERE id = $1`, [job.id, JSON.stringify({
      analysis: result.overall_analysis, suggestions: result.overall_suggestions, model: grade.model || "",
    })]);
    await settleDeskBatch(client, job.batchId);
    return true;
  });
}

async function failWholePaperJob(job, message) {
  return deskTransaction(async (client) => {
    if (!(await lockWholePaperJob(client, job))) return false;
    await client.query(`UPDATE grading_jobs SET status = 'failed', finished_at = now(), error = $2,
      lease_token = NULL, lease_expires_at = NULL WHERE id = $1`, [job.id, String(message || "评分失败。").slice(0, 1000)]);
    await settleDeskBatch(client, job.batchId);
    return true;
  });
}

module.exports = {
  createDeskExam, captureDeskPage, confirmDeskPages, updateDeskQuestions, startDeskGrading, retryDeskGrading,
  listDeskAssignments, getDeskDetail, getDeskImage, getDeskAnswerImage, assertLegacyMutationAllowed,
  preflightDeskBatch, relocateDeskStudentPage, saveDeskRegions, saveDeskSubScore, regradeDeskQuestion,
  recoverWholePaperJobs, claimWholePaperJob, renewWholePaperLease, getWholePaperJobPayload,
  completeWholePaperJob, failWholePaperJob, touchWorkerHeartbeat, isWorkerHeartbeatFresh,
  recoverPaperGroupJobs, claimPaperGroupJobs, renewPaperGroupLease, getPaperGroupJobPayload,
  completePaperGroupJob, failPaperGroupJob,
  assertBatchOwnership,
  assertClassOwnership,
  assertExamOwnership,
  assertQuestionOwnership,
  assertStudentOwnership,
  assertTemplateOwnership,
  claimNextGradingJob,
  completeGradingJob,
  createClass,
  createAiGradingHistory,
  createExam,
  createExamQuestion,
  createPair,
  createPaperTemplate,
  createScanBatch,
  createScannedPage,
  createStudent,
  createUpload,
  deleteAiGradingHistory,
  deleteUploads,
  examHasTemplateRegions,
  failGradingJob,
  getAssignmentOverview,
  getBatchAnalysis,
  getBatchAnalysisAiPayload,
  getBatchResults,
  getClassHistoryAnalysis,
  getExamKnowledgePoints,
  getGradingJobPayload,
  getOrCreateExamBatch,
  getStudentGradingProgress,
  getStudentPageImage,
  getStudentHistoryAnalysis,
  getStudentSubmission,
  importStudents,
  initDatabase,
  listClasses,
  listExamProgress,
  listExamQuestions,
  listExams,
  listAiGradingHistory,
  listPairs,
  listPaperTemplates,
  listScanBatches,
  listScannedPages,
  listStudents,
  listTemplateRegions,
  listUploads,
  processScanBatch,
  processStudentSubmission,
  replaceStudentSubmission,
  saveBatchAnalysis,
  saveWholePaperResults,
  saveTemplateRegion,
};
