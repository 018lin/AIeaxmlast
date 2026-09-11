const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const sharp = require("sharp");

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
      ORDER BY s.created_at DESC
      LIMIT 500
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
      INSERT INTO exam_questions (id, exam_id, question_no, title, max_score, rubric, knowledge_points)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, exam_id, question_no, title, max_score, rubric, knowledge_points, created_at
    `,
    [
      randomUUID(),
      examId,
      questionNo,
      String(payload.title || "").trim(),
      maxScore,
      String(payload.rubric || "").trim(),
      JSON.stringify(knowledgePoints),
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
      SELECT id, exam_id, question_no, title, max_score, rubric, knowledge_points, created_at
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
      const pageBuffer = Buffer.from(page.image_data);
      const metadata = await sharp(pageBuffer).metadata();
      const sourceWidth = Number(metadata.width || 0);
      const sourceHeight = Number(metadata.height || 0);

      if (!sourceWidth || !sourceHeight) {
        throw new Error(`扫描答卷 ${page.original_name} 图片尺寸无效。`);
      }

      for (const region of regionsResult.rows) {
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

async function claimNextGradingJob(batchId) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(
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
  getBatchResults,
  getGradingJobPayload,
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
  saveTemplateRegion,
};
