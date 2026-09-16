# Exam Grader

Online exam platform with AI-graded open-ended answers. Multiple-choice and
short-answer questions are auto-graded server-side; extended-response
answers are graded by the Claude API against a teacher-written rubric, with
a specific feedback paragraph per answer. Results are emailed automatically
when the student finishes.

Built for IGCSE Design & Technology at Marymount Medellín, in production
since August 2026.

**Live:** https://workwebsitesmixed.github.io/exam-grader/

## Why

Grading open-ended answers by hand was slow and inconsistent between
students, and feedback could take up to two weeks to reach the student —
by then they'd moved on to another topic. Automating the grading frees up
the class time that used to go into whole-group correction, so it can be
reinvested in peer feedback instead.

## How it works

- **Backend:** Google Apps Script + Google Sheets as the database — no
  additional infrastructure.
- **Grading:** multiple-choice and short-answer are graded server-side;
  open-ended answers go to the Claude API along with the question's rubric
  (the rubric and correct answer are never exposed to the student).
- **Academic integrity:** institutional Google sign-in, timed exams, tab-switch
  detection with escalating penalties (auto-submit on the third switch),
  one attempt per student per exam.
- **IGCSE mode:** can import a past paper's question text and marking scheme
  from a PDF and generate the grading rubric automatically.

## Structure

| file | what it is |
|---|---|
| `Code.gs` | Apps Script backend — grading, submissions, admin API |
| `appsscript.json` | Apps Script manifest |
| `grader.html` | the exam-taking page students see |
| `admin.html` | teacher panel — submissions, per-question AI feedback, config |
| `results.html` | student-facing results page |
| `index.html` | landing page |
| `tools/` | local, git-ignored dev tooling (not part of the deployed app) |

## Deploying your own

This repo is the reference implementation. For a guided, prompt-based path
to building your own version with [Claude Code](https://claude.com/claude-code),
see [exam-grader-diy](https://workwebsitesmixed.github.io/exam-grader-diy/).

---

Andrés Felipe Forero Beltrán · Marymount Medellín
