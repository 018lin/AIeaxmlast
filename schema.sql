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
  created_at timestamptz NOT NULL DEFAULT now()
);

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
  created_at timestamptz NOT NULL DEFAULT now()
);

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
