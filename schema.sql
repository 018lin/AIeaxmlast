CREATE TABLE IF NOT EXISTS uploaded_images (
  id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL CHECK (
    kind IN (
      'paper',
      'answer',
      'single_question',
      'student_answer',
      'paper_crop',
      'answer_crop',
      'template_page',
      'scanned_page'
    )
  ),
  original_name text NOT NULL,
  mime_type varchar(64) NOT NULL,
  image_data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS question_answer_pairs (
  id uuid PRIMARY KEY,
  paper_image_id uuid REFERENCES uploaded_images(id) ON DELETE SET NULL,
  answer_image_id uuid REFERENCES uploaded_images(id) ON DELETE SET NULL,
  paper_crop_image_id uuid NOT NULL REFERENCES uploaded_images(id) ON DELETE CASCADE,
  answer_crop_image_id uuid NOT NULL REFERENCES uploaded_images(id) ON DELETE CASCADE,
  paper_selection jsonb NOT NULL,
  answer_selection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uploaded_images_kind_created_idx
  ON uploaded_images (kind, created_at DESC);

CREATE INDEX IF NOT EXISTS question_answer_pairs_created_idx
  ON question_answer_pairs (created_at DESC);

CREATE TABLE IF NOT EXISTS ai_grading_history (
  id uuid PRIMARY KEY,
  question_image_id uuid REFERENCES uploaded_images(id) ON DELETE SET NULL,
  answer_image_id uuid REFERENCES uploaded_images(id) ON DELETE SET NULL,
  question_name text NOT NULL,
  answer_name text NOT NULL,
  max_score numeric NOT NULL,
  rubric text NOT NULL DEFAULT '',
  model text NOT NULL,
  score numeric,
  level text NOT NULL DEFAULT '',
  analysis text NOT NULL DEFAULT '',
  deductions jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_content text NOT NULL DEFAULT '',
  ai_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_grading_history_created_idx
  ON ai_grading_history (created_at DESC);

ALTER TABLE uploaded_images DROP CONSTRAINT IF EXISTS uploaded_images_kind_check;

ALTER TABLE uploaded_images ADD CONSTRAINT uploaded_images_kind_check CHECK (
  kind IN (
    'paper',
    'answer',
    'single_question',
    'student_answer',
    'paper_crop',
    'answer_crop',
    'template_page',
    'scanned_page'
  )
);

CREATE TABLE IF NOT EXISTS classes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  grade text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY,
  class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
  name text NOT NULL,
  student_no text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS students_class_idx
  ON students (class_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exams (
  id uuid PRIMARY KEY,
  class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  exam_date date,
  total_score numeric NOT NULL DEFAULT 0,
  knowledge_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE exams ADD COLUMN IF NOT EXISTS knowledge_points jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS exams_class_created_idx
  ON exams (class_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exam_questions (
  id uuid PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_no text NOT NULL,
  title text NOT NULL DEFAULT '',
  max_score numeric NOT NULL,
  rubric text NOT NULL DEFAULT '',
  knowledge_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  question_type text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE exam_questions ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS exam_questions_exam_idx
  ON exam_questions (exam_id, created_at ASC);

CREATE TABLE IF NOT EXISTS paper_templates (
  id uuid PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  image_id uuid REFERENCES uploaded_images(id) ON DELETE SET NULL,
  name text NOT NULL DEFAULT '',
  width integer NOT NULL DEFAULT 0,
  height integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_templates_exam_idx
  ON paper_templates (exam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS template_regions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES paper_templates(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  x_ratio numeric NOT NULL,
  y_ratio numeric NOT NULL,
  width_ratio numeric NOT NULL,
  height_ratio numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, question_id)
);

CREATE INDEX IF NOT EXISTS template_regions_template_idx
  ON template_regions (template_id, created_at ASC);

CREATE TABLE IF NOT EXISTS scan_batches (
  id uuid PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  name text NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_batches_exam_created_idx
  ON scan_batches (exam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scanned_pages (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  image_id uuid NOT NULL REFERENCES uploaded_images(id) ON DELETE CASCADE,
  original_name text NOT NULL DEFAULT '',
  page_no integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scanned_pages_batch_idx
  ON scanned_pages (batch_id, created_at ASC);

CREATE TABLE IF NOT EXISTS answer_crops (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  scanned_page_id uuid NOT NULL REFERENCES scanned_pages(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  crop_image_id uuid NOT NULL REFERENCES uploaded_images(id) ON DELETE CASCADE,
  crop_box jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scanned_page_id, question_id)
);

CREATE INDEX IF NOT EXISTS answer_crops_batch_idx
  ON answer_crops (batch_id, created_at ASC);

CREATE TABLE IF NOT EXISTS grading_jobs (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  answer_crop_id uuid NOT NULL REFERENCES answer_crops(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (answer_crop_id)
);

CREATE INDEX IF NOT EXISTS grading_jobs_batch_status_idx
  ON grading_jobs (batch_id, status, created_at ASC);

CREATE TABLE IF NOT EXISTS grading_results (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES grading_jobs(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  score numeric,
  max_score numeric NOT NULL,
  level text NOT NULL DEFAULT '',
  analysis text NOT NULL DEFAULT '',
  deductions jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_content text NOT NULL DEFAULT '',
  ai_result jsonb,
  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS grading_results_batch_student_idx
  ON grading_results (batch_id, student_id, created_at ASC);

CREATE INDEX IF NOT EXISTS grading_results_student_exam_idx
  ON grading_results (student_id, exam_id, question_id, created_at DESC);

CREATE INDEX IF NOT EXISTS grading_results_exam_idx
  ON grading_results (exam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assignment_analyses (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id)
);

CREATE INDEX IF NOT EXISTS assignment_analyses_batch_idx
  ON assignment_analyses (batch_id, created_at DESC);

-- 教师数据归属：历史数据默认归属初始账号 018
ALTER TABLE classes ADD COLUMN IF NOT EXISTS teacher_account text NOT NULL DEFAULT '018';
ALTER TABLE students ADD COLUMN IF NOT EXISTS teacher_account text NOT NULL DEFAULT '018';
ALTER TABLE exams ADD COLUMN IF NOT EXISTS teacher_account text NOT NULL DEFAULT '018';
ALTER TABLE ai_grading_history ADD COLUMN IF NOT EXISTS teacher_account text NOT NULL DEFAULT '018';

CREATE INDEX IF NOT EXISTS classes_teacher_created_idx
  ON classes (teacher_account, created_at DESC);

CREATE INDEX IF NOT EXISTS students_teacher_class_idx
  ON students (teacher_account, class_id, created_at DESC);

CREATE INDEX IF NOT EXISTS exams_teacher_created_idx
  ON exams (teacher_account, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_grading_history_teacher_idx
  ON ai_grading_history (teacher_account, created_at DESC);

-- P1 desk: additive, opt-in fields; existing crop workflows retain their defaults.
ALTER TABLE uploaded_images ADD COLUMN IF NOT EXISTS desk_private boolean NOT NULL DEFAULT false;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS desk_managed boolean NOT NULL DEFAULT false;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS answer_image_id uuid REFERENCES uploaded_images(id) ON DELETE RESTRICT;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS answer_total_score numeric;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS student_order_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE exam_questions ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;
ALTER TABLE scan_batches ADD COLUMN IF NOT EXISTS desk_managed boolean NOT NULL DEFAULT false;
ALTER TABLE scan_batches ADD COLUMN IF NOT EXISTS capture_version integer NOT NULL DEFAULT 0;
ALTER TABLE scan_batches ADD COLUMN IF NOT EXISTS confirmed_version integer;
ALTER TABLE scan_batches ADD COLUMN IF NOT EXISTS confirmed_page_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE scan_batches ADD COLUMN IF NOT EXISTS grading_started_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS scan_batches_desk_exam_idx ON scan_batches (exam_id) WHERE desk_managed;
ALTER TABLE scanned_pages ADD COLUMN IF NOT EXISTS capture_order integer CHECK (capture_order >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS scanned_pages_capture_order_idx
  ON scanned_pages (batch_id, capture_order) WHERE capture_order IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scanned_pages_desk_student_idx
  ON scanned_pages (batch_id, student_id) WHERE capture_order IS NOT NULL;
ALTER TABLE grading_jobs ADD COLUMN IF NOT EXISTS scanned_page_id uuid REFERENCES scanned_pages(id) ON DELETE CASCADE;
ALTER TABLE grading_jobs ADD COLUMN IF NOT EXISTS job_kind varchar(24) NOT NULL DEFAULT 'crop'
  CHECK (job_kind IN ('crop', 'whole_paper'));
ALTER TABLE grading_jobs ALTER COLUMN answer_crop_id DROP NOT NULL;
ALTER TABLE grading_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE grading_jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE grading_jobs ADD COLUMN IF NOT EXISTS overall_feedback jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS grading_jobs_whole_page_idx
  ON grading_jobs (scanned_page_id) WHERE job_kind = 'whole_paper';
CREATE INDEX IF NOT EXISTS grading_jobs_whole_claim_idx
  ON grading_jobs (status, lease_expires_at, created_at) WHERE job_kind = 'whole_paper';
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS confidence numeric CHECK (confidence BETWEEN 0 AND 1);
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS final_score numeric;
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS teacher_comment text NOT NULL DEFAULT '';
-- One whole-paper job owns several results. Existing crop job uniqueness is subsumed.
ALTER TABLE grading_results DROP CONSTRAINT IF EXISTS grading_results_job_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS grading_results_job_question_idx ON grading_results (job_id, question_id);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- 批改模式：fast 高效模式（单次评判）/ fine 精批模式（双评 + 争议仲裁）。
-- 模式存在教师账户上作为默认值，并在“开始批改”时快照进 grading_jobs，
-- 之后改偏好不会影响已开始或已完成的批次。
CREATE TABLE IF NOT EXISTS teacher_settings (
  account text PRIMARY KEY,
  grading_mode varchar(16) NOT NULL DEFAULT 'fast' CHECK (grading_mode IN ('fast', 'fine')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE grading_jobs ADD COLUMN IF NOT EXISTS grading_mode varchar(16) NOT NULL DEFAULT 'fast'
  CHECK (grading_mode IN ('fast', 'fine'));

-- single 单次评判 / agree 两次一致 / arbitrated 已仲裁 / disputed 仲裁仍不确定。
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS agreement varchar(16) NOT NULL DEFAULT 'single';
-- 两次独立评判与仲裁的原始结论，供详情页展示“为什么有争议”，也为后续校准阈值留数据。
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS passes jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS grading_jobs_batch_mode_idx
  ON grading_jobs (batch_id, grading_mode);
