-- Upload pipeline indexes. Extracted text is read per attachment when a
-- comparison is planned (documents by file_id, then chunks by document_id), and
-- the files table grows with every upload. 001 declared the tables but no read
-- index; without these, each attachment scan reads whole tables.
CREATE INDEX IF NOT EXISTS documents_file_idx ON documents (file_id, processing_version);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS extraction_jobs_file_idx ON extraction_jobs (file_id, updated_at);
CREATE INDEX IF NOT EXISTS files_user_created_idx ON files (user_id, created_at);
