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
