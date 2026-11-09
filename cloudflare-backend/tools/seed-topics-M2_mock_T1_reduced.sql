-- Topic tags for M2_mock_T1_reduced (Grade 10, Term I), proposed from the question text
-- and the department's Term I concepts. Apply AFTER migrations/006_topic.sql:
--   npx wrangler d1 execute examgrader --remote --file=tools/seed-topics-M2_mock_T1_reduced.sql
UPDATE questions SET topic = 'Design communication' WHERE exam_id = 'M2_mock_T1_reduced' AND qid IN ('Q2a','Q2b','Q2c');
UPDATE questions SET topic = 'Design specification' WHERE exam_id = 'M2_mock_T1_reduced' AND qid IN ('Q1','Q7a','Q7b','Q7c','Q8');
UPDATE questions SET topic = 'Mechanisms and motion' WHERE exam_id = 'M2_mock_T1_reduced' AND qid IN ('Q3a','Q3b','Q4a','Q4b','Q5','Q6a','Q6b','Q6c','Q9a','Q9b');
UPDATE questions SET topic = 'Electronics' WHERE exam_id = 'M2_mock_T1_reduced' AND qid IN ('Q10','Q11','Q13a','Q13b');
UPDATE questions SET topic = 'Workshop safety' WHERE exam_id = 'M2_mock_T1_reduced' AND qid = 'Q12';
