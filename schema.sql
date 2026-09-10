CREATE TABLE IF NOT EXISTS uploaded_images (
  id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL CHECK (
    kind IN (
      'paper',
      'answer',
      'single_question',
      'student_answer',
      'paper_crop',
      'answer_crop'
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
