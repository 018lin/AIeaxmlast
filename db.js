const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const sharp = require("sharp");
const XLSX = require("xlsx");

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

async function createClass(payload) {
  const name = String(payload.name || "").trim();

  if (!name) {
    throw new Error("班级名称不能为空。");
  }

  const result = await getPool().query(
    `
      INSERT INTO classes (id, name, grade)
      VALUES ($1, $2, $3)
      RETURNING id, name, grade, created_at
    `,
    [randomUUID(), name, String(payload.grade || "").trim()]
  );

  return mapClass(result.rows[0]);
}

async function listClasses() {
  const result = await getPool().query(`
    SELECT id, name, grade, created_at
    FROM classes
    ORDER BY created_at DESC
    LIMIT 200
  `);

  return result.rows.map(mapClass);
}

async function createStudent(payload) {
  const name = String(payload.name || "").trim();

  if (!name) {
    throw new Error("学生姓名不能为空。");
  }

  const result = await getPool().query(
    `
      INSERT INTO students (id, class_id, name, student_no)
      VALUES ($1, $2, $3, $4)
      RETURNING id, class_id, name, student_no, created_at
    `,
    [randomUUID(), payload.classId || null, name, String(payload.studentNo || "").trim()]
  );

  return mapStudent(result.rows[0]);
}

async function listStudents(classId) {
  const values = [];
  let whereClause = "";

  if (classId) {
    values.push(classId);
    whereClause = "WHERE s.class_id = $1";
  }

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

async function createExam(payload) {
  const name = String(payload.name || "").trim();

  if (!name) {
    throw new Error("考试名称不能为空。");
  }

  const result = await getPool().query(
    `
      INSERT INTO exams (id, class_id, name, subject, exam_date, total_score)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, class_id, name, subject, exam_date, total_score, created_at
    `,
    [
      randomUUID(),
      payload.classId || null,
      name,
      String(payload.subject || "").trim(),
      payload.examDate || null,
      getNumericValue(payload.totalScore) || 0,
    ]
  );

  return mapExam(result.rows[0]);
}

async function listExams() {
  const result = await getPool().query(`
    SELECT
      e.id,
      e.class_id,
      c.name AS class_name,
      e.name,
      e.subject,
      e.exam_date,
      e.total_score,
      e.created_at,
      COUNT(q.id) AS question_count
    FROM exams e
    LEFT JOIN classes c ON c.id = e.class_id
    LEFT JOIN exam_questions q ON q.exam_id = e.id
    GROUP BY e.id, c.name
    ORDER BY e.created_at DESC
    LIMIT 200
  `);

  return result.rows.map(mapExam);
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

async function listScanBatches(examId) {
  const values = [];
  let whereClause = "";

  if (examId) {
    values.push(examId);
    whereClause = "WHERE b.exam_id = $1";
  }

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

async function getClassRecord(classId) {
  const result = await getPool().query(
    "SELECT id, name, grade, created_at FROM classes WHERE id = $1",
    [classId]
  );

  if (result.rowCount === 0) {
    throw new Error("班级不存在。");
  }

  return mapClass(result.rows[0]);
}

async function getExamRecord(examId) {
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
        e.created_at,
        COUNT(q.id) AS question_count
      FROM exams e
      LEFT JOIN classes c ON c.id = e.class_id
      LEFT JOIN exam_questions q ON q.exam_id = e.id
      WHERE e.id = $1
      GROUP BY e.id, c.name
    `,
    [examId]
  );

  if (result.rowCount === 0) {
    throw new Error("作业不存在。");
  }

  return mapExam(result.rows[0]);
}

async function importStudents(payload) {
  const file = payload.file || payload.excel || "";

  if (!file) {
    throw new Error("请上传包含学生名单的 Excel 文件。");
  }

  let classItem;

  if (payload.classId) {
    classItem = await getClassRecord(payload.classId);
  } else {
    const className = String(payload.className || "").trim();

    if (!className) {
      throw new Error("请选择已有班级，或填写新班级名称。");
    }

    classItem = await createClass({ name: className, grade: payload.grade });
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
          INSERT INTO students (id, class_id, name, student_no)
          VALUES ($1, $2, $3, $4)
        `,
        [randomUUID(), classItem.id, row.name, row.studentNo]
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
    students: await listStudents(classItem.id),
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

  const [resultsResult, questionsResult, progress] = await Promise.all([
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
          ai.mime_type AS answer_mime_type,
          ai.image_data AS answer_image_data
        FROM grading_results gr
        JOIN exam_questions q ON q.id = gr.question_id
        JOIN grading_jobs j ON j.id = gr.job_id
        JOIN answer_crops ac ON ac.id = j.answer_crop_id
        JOIN uploaded_images ai ON ai.id = ac.crop_image_id
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
  ]);

  const results = [];

  for (const row of resultsResult.rows) {
    let answerImage = "";

    if (includeImages && row.answer_image_data) {
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
            WHERE batch_id = $1 AND status IN ('pending', 'failed') AND attempts < 3
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
        getNumericValue(result.score),
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

module.exports = {
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
  failGradingJob,
  getAssignmentOverview,
  getBatchAnalysis,
  getBatchAnalysisAiPayload,
  getBatchResults,
  getClassHistoryAnalysis,
  getGradingJobPayload,
  getOrCreateExamBatch,
  getStudentGradingProgress,
  getStudentHistoryAnalysis,
  getStudentSubmission,
  importStudents,
  initDatabase,
  listClasses,
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
  saveTemplateRegion,
};
