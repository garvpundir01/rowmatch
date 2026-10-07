-- A small university schema. Deliberately shaped so the benchmark can ask
-- questions that need joins, aggregates, grouping, ordering and NULLs, since
-- those are where a predicted query goes subtly wrong rather than loudly wrong.

CREATE TABLE departments (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  building TEXT
);

CREATE TABLE instructors (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  dept_id INTEGER REFERENCES departments(id),
  salary  REAL
);

CREATE TABLE students (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  dept_id INTEGER REFERENCES departments(id),
  gpa     REAL,
  year    INTEGER
);

CREATE TABLE courses (
  id      INTEGER PRIMARY KEY,
  title   TEXT NOT NULL,
  dept_id INTEGER REFERENCES departments(id),
  credits INTEGER
);

CREATE TABLE enrollments (
  student_id INTEGER REFERENCES students(id),
  course_id  INTEGER REFERENCES courses(id),
  grade      REAL,
  PRIMARY KEY (student_id, course_id)
);

INSERT INTO departments (id, name, building) VALUES
  (1, 'Computer Sciences', 'Morgridge'),
  (2, 'Mathematics',       'Van Vleck'),
  (3, 'Statistics',        'Medical Sciences'),
  (4, 'Philosophy',        NULL);

INSERT INTO instructors (id, name, dept_id, salary) VALUES
  (1, 'Okonkwo',  1, 142000.0),
  (2, 'Ramirez',  1, 128500.0),
  (3, 'Lindqvist',2, 119000.0),
  (4, 'Baptiste', 3, 131000.0),
  (5, 'Haugen',   3,  98000.0),
  (6, 'Castellan',4,  87500.0);

INSERT INTO students (id, name, dept_id, gpa, year) VALUES
  (1,  'Adeyemi',   1, 3.91, 4),
  (2,  'Brannigan', 1, 3.42, 2),
  (3,  'Cho',       1, 3.78, 3),
  (4,  'Delacroix', 1, 2.95, 1),
  (5,  'Ersoy',     2, 3.66, 3),
  (6,  'Falkenrath',2, 3.21, 2),
  (7,  'Gharibian', 3, 3.88, 4),
  (8,  'Hollenbeck',3, 3.05, 1),
  (9,  'Iwasaki',   3, 3.55, 2),
  (10, 'Jovanovic', 4, 3.72, 4),
  (11, 'Kaminski',  4, 2.84, 1),
  (12, 'Lindgren',  1, NULL, 1);

INSERT INTO courses (id, title, dept_id, credits) VALUES
  (1, 'Database Management Systems', 1, 4),
  (2, 'Operating Systems',           1, 4),
  (3, 'Machine Organization',        1, 3),
  (4, 'Linear Algebra',              2, 3),
  (5, 'Real Analysis',               2, 3),
  (6, 'Statistical Inference',       3, 4),
  (7, 'Regression Methods',          3, 3),
  (8, 'Formal Logic',                4, 3);

INSERT INTO enrollments (student_id, course_id, grade) VALUES
  (1, 1, 3.9), (1, 2, 4.0), (1, 3, 3.7),
  (2, 1, 3.1), (2, 3, 3.3),
  (3, 1, 3.8), (3, 2, 3.6), (3, 4, 3.9),
  (4, 3, 2.7), (4, 2, 3.0),
  (5, 4, 3.8), (5, 5, 3.5), (5, 1, 3.4),
  (6, 4, 3.2), (6, 5, 3.0),
  (7, 6, 4.0), (7, 7, 3.8), (7, 1, 3.9),
  (8, 6, 2.9), (8, 7, 3.2),
  (9, 6, 3.5), (9, 7, 3.6), (9, 4, 3.4),
  (10, 8, 3.9), (10, 5, 3.3),
  (11, 8, 2.8),
  (12, 1, NULL);
