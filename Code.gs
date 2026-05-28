// ============================================================
// Code.gs  -  Exam Auto-Grader Backend
// Paste this entire file into your Google Apps Script editor,
// replace PASTE_YOUR_KEY_HERE with your Gemini API key,
// then deploy as a new Web App version (Anyone can access).
// ============================================================

var GEMINI_API_KEY    = 'PASTE_YOUR_KEY_HERE';
var SUBMISSIONS_SHEET = 'Submissions';
var DETAILS_SHEET     = 'Detailed_Answers';
var QUESTIONS_SHEET   = 'Questions';
var CONFIG_SHEET      = 'Config';

var OPEN_MAX_PER_Q = 8;
var YGG_MAX_PER_Q  = 10;

// 1-based column indices for the Submissions sheet
var COL = {
  TIMESTAMP:    1,
  FIRST_NAME:   2,
  LAST_NAME:    3,
  EMAIL:        4,
  CLASS:        5,
  SET:          6,
  MC_SCORE:     7,
  OPEN_SCORE:   8,
  YGG_SCORE:    9,
  PENALTY:      10,
  TAB_SWITCHES: 11,
  TOTAL_SCORE:  12,
  MAX_SCORE:    13,
  PERCENTAGE:   14,
  FINAL_GRADE:  15,
  BONUS:        16,
  OPEN_FB:      17,
  YGG_FB:       18,
  Q1_AI:        19,
  Q2_AI:        20,
  Q3_AI:        21,
  Q4_AI:        22,
  Q5_AI:        23,
  Q1_OVR:       24,
  Q2_OVR:       25,
  Q3_OVR:       26,
  Q4_OVR:       27,
  Q5_OVR:       28,
  YGG1_AI:      29,
  YGG2_AI:      30,
  YGG3_AI:      31,
  YGG1_OVR:     32,
  YGG2_OVR:     33,
  YGG3_OVR:     34
};

// Detailed_Answers sheet — 0-based column indices
var DCOL = {
  TIMESTAMP:      0,
  EMAIL:          1,
  LAST_NAME:      2,
  FIRST_NAME:     3,
  CLASS:          4,
  SET:            5,
  QUESTION_ID:    6,
  TYPE:           7,
  QUESTION_TEXT:  8,
  STUDENT_ANSWER: 9,
  CORRECT_ANSWER: 10,
  IS_CORRECT:     11,
  AI_SCORE:       12,
  MAX_SCORE:      13,
  AI_FEEDBACK:    14
};

// Hardcoded fallback — overridden at runtime by grade_boundaries_A/B/C in Config sheet
var GRADE_BOUNDARIES = {
  A: [
    {grade: '2.3', min: 85}, {grade: '2.0', min: 70},
    {grade: '1.7', min: 50}, {grade: '1.3', min: 35}, {grade: '1.0', min: 0}
  ],
  B: [
    {grade: '3.3', min: 85}, {grade: '3.0', min: 75}, {grade: '2.7', min: 65},
    {grade: '2.3', min: 55}, {grade: '2.0', min: 45}, {grade: '1.7', min: 35},
    {grade: '1.3', min: 20}, {grade: '1.0', min: 0}
  ],
  C: [
    {grade: '4.0', min: 90}, {grade: '3.7', min: 80}, {grade: '3.3', min: 70},
    {grade: '3.0', min: 60}, {grade: '2.7', min: 50}, {grade: '2.3', min: 40},
    {grade: '2.0', min: 30}, {grade: '1.7', min: 20}, {grade: '1.3', min: 10}, {grade: '1.0', min: 0}
  ]
};

// ============================================================
// GRADE BOUNDARY HELPERS
// ============================================================
function parseBoundaryString(str) {
  var result = [];
  var pairs = str.split(',');
  for (var i = 0; i < pairs.length; i++) {
    var parts = pairs[i].trim().split(':');
    if (parts.length === 2) {
      var g = parts[0].trim();
      var m = parseInt(parts[1].trim(), 10);
      if (g && !isNaN(m)) { result.push({grade: g, min: m}); }
    }
  }
  return result.length ? result : null;
}

function loadEffectiveBoundaries() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = ss.getSheetByName(CONFIG_SHEET);
  if (!configSheet) { return GRADE_BOUNDARIES; }
  var rows = configSheet.getDataRange().getValues();
  var cfg = {};
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i][0]).trim();
    var v = String(rows[i][1]).trim();
    if (k) { cfg[k] = v; }
  }
  var result = {};
  var sets = ['A', 'B', 'C'];
  for (var si = 0; si < sets.length; si++) {
    var key = 'grade_boundaries_' + sets[si];
    var parsed = cfg[key] ? parseBoundaryString(cfg[key]) : null;
    result[sets[si]] = parsed || GRADE_BOUNDARIES[sets[si]];
  }
  return result;
}

// ============================================================
// MENU
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Exam Tools')
    .addItem('Setup: Create Config & Questions sheets', 'setup')
    .addSeparator()
    .addItem('Recalculate Grades with Overrides', 'recalculateWithOverrides')
    .addSeparator()
    .addItem('Backfill AI Scores (for old rows)', 'backfillAIScores')
    .addToUi();
}

// ============================================================
// GET HANDLER
// ============================================================
function doGet(e) {
  var action = (e.parameter && e.parameter.action) ? e.parameter.action : '';
  if (action === 'submissions') { return getSubmissionsResponse(); }
  if (action === 'config')      { return getConfigResponse(); }
  if (action === 'myresults')   { return getMyResultsResponse(e.parameter.email || ''); }
  if (action === 'details')     { return getDetailsResponse(e.parameter.timestamp || ''); }
  return getQuestionsResponse();
}

// ============================================================
// GET: QUESTIONS + CONFIG
// ============================================================
function getQuestionsResponse() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var configSheet = ss.getSheetByName(CONFIG_SHEET);
  if (!configSheet) { configSheet = createConfigSheet(ss); }
  var configRows = configSheet.getDataRange().getValues();
  var config = {};
  for (var i = 0; i < configRows.length; i++) {
    var k = String(configRows[i][0]).trim();
    var v = String(configRows[i][1]).trim();
    if (k) { config[k] = v; }
  }

  var qSheet = ss.getSheetByName(QUESTIONS_SHEET);
  if (!qSheet) { qSheet = createQuestionsSheet(ss); }
  var qRows = qSheet.getDataRange().getValues();

  var questions = {A: [], B: [], C: [], Yggdrasil: []};

  for (var r = 1; r < qRows.length; r++) {
    var row = qRows[r];
    var set     = String(row[0]).trim();
    var id      = String(row[1]).trim();
    var section = String(row[2]).trim();
    var type    = String(row[3]).trim();
    var points  = Number(row[4]);
    var text    = String(row[5]).trim();
    var optA    = String(row[6]).trim();
    var optB    = String(row[7]).trim();
    var optC    = String(row[8]).trim();
    var optD    = String(row[9]).trim();
    var correctIndex = (row[10] !== '' && row[10] !== null && row[10] !== undefined) ? Number(row[10]) : null;
    var rubric  = String(row[11]).trim();

    if (!set || !id || !text) { continue; }

    var q = {id: id, section: section, type: type, points: points, text: text, rubric: rubric};

    if (type === 'mc') {
      var opts = [optA, optB, optC, optD];
      var indices = [0, 1, 2, 3];
      shuffleIndices(indices);
      q.options      = opts;
      q.correctIndex = correctIndex;
      q.shuffled     = indices;
    }

    if (set === 'Yggdrasil') {
      questions.Yggdrasil.push(q);
    } else if (questions[set] !== undefined) {
      questions[set].push(q);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({success: true, questions: questions, config: config}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GET: CONFIG ONLY
// ============================================================
function getConfigResponse() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = ss.getSheetByName(CONFIG_SHEET);
  if (!configSheet) {
    return ContentService
      .createTextOutput(JSON.stringify({config: {}}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var configRows = configSheet.getDataRange().getValues();
  var config = {};
  for (var i = 0; i < configRows.length; i++) {
    var k = String(configRows[i][0]).trim();
    var v = String(configRows[i][1]).trim();
    if (k) { config[k] = v; }
  }
  return ContentService
    .createTextOutput(JSON.stringify({config: config}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GET: MY RESULTS  (student self-lookup by email)
// ============================================================
function getMyResultsResponse(email) {
  if (!email) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'No email provided'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sub = ss.getSheetByName(SUBMISSIONS_SHEET);
  var det = ss.getSheetByName(DETAILS_SHEET);

  var submissionsData = sub ? sub.getDataRange().getValues() : [];
  var detailsData     = det ? det.getDataRange().getValues() : [];

  // Collect matching submissions
  var matchedTimestamps = {};
  var submissions = [];

  for (var i = 1; i < submissionsData.length; i++) {
    var row = submissionsData[i];
    if (String(row[COL.EMAIL - 1]).toLowerCase() !== email.toLowerCase()) { continue; }

    var ts = String(row[COL.TIMESTAMP - 1]);
    matchedTimestamps[ts] = true;

    submissions.push({
      timestamp:        ts,
      firstName:        String(row[COL.FIRST_NAME  - 1]),
      lastName:         String(row[COL.LAST_NAME   - 1]),
      class:            String(row[COL.CLASS        - 1]),
      set:              String(row[COL.SET          - 1]),
      mcScore:          Number(row[COL.MC_SCORE     - 1]) || 0,
      openScore:        Number(row[COL.OPEN_SCORE   - 1]) || 0,
      penalty:          Number(row[COL.PENALTY      - 1]) || 0,
      totalScore:       Number(row[COL.TOTAL_SCORE  - 1]) || 0,
      maxScore:         Number(row[COL.MAX_SCORE    - 1]) || 0,
      percentage:       Number(row[COL.PERCENTAGE   - 1]) || 0,
      finalGrade:       String(row[COL.FINAL_GRADE  - 1]),
      bonus:            Number(row[COL.BONUS        - 1]) || 0,
      details:          []
    });
  }

  // Attach detailed answers by timestamp
  var detailsByTs = {};
  for (var d = 1; d < detailsData.length; d++) {
    var dr  = detailsData[d];
    var dts = String(dr[DCOL.TIMESTAMP]);
    if (!matchedTimestamps[dts]) { continue; }
    if (!detailsByTs[dts]) { detailsByTs[dts] = []; }
    detailsByTs[dts].push({
      questionId:    String(dr[DCOL.QUESTION_ID]),
      type:          String(dr[DCOL.TYPE]),
      questionText:  String(dr[DCOL.QUESTION_TEXT]),
      studentAnswer: String(dr[DCOL.STUDENT_ANSWER]),
      correctAnswer: String(dr[DCOL.CORRECT_ANSWER]),
      isCorrect:     dr[DCOL.IS_CORRECT],
      aiScore:       Number(dr[DCOL.AI_SCORE])  || 0,
      maxScore:      Number(dr[DCOL.MAX_SCORE]) || 0,
      aiFeedback:    String(dr[DCOL.AI_FEEDBACK])
    });
  }

  for (var s = 0; s < submissions.length; s++) {
    submissions[s].details = detailsByTs[submissions[s].timestamp] || [];
  }

  // Most recent first
  submissions.sort(function(a, b) {
    return a.timestamp < b.timestamp ? 1 : -1;
  });

  return ContentService
    .createTextOutput(JSON.stringify({success: true, submissions: submissions}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GET: DETAILS FOR ONE SUBMISSION  (admin modal lazy-load)
// ============================================================
function getDetailsResponse(timestamp) {
  if (!timestamp) {
    return ContentService
      .createTextOutput(JSON.stringify({details: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DETAILS_SHEET);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({details: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data    = sheet.getDataRange().getValues();
  var details = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[DCOL.TIMESTAMP]) !== String(timestamp)) { continue; }
    details.push({
      questionId:    String(row[DCOL.QUESTION_ID]),
      type:          String(row[DCOL.TYPE]),
      questionText:  String(row[DCOL.QUESTION_TEXT]),
      studentAnswer: String(row[DCOL.STUDENT_ANSWER]),
      correctAnswer: String(row[DCOL.CORRECT_ANSWER]),
      isCorrect:     row[DCOL.IS_CORRECT],
      aiScore:       Number(row[DCOL.AI_SCORE])  || 0,
      maxScore:      Number(row[DCOL.MAX_SCORE]) || 0,
      aiFeedback:    String(row[DCOL.AI_FEEDBACK])
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({details: details}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GET: SUBMISSIONS  (admin panel)
// ============================================================
function getSubmissionsResponse() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({submissions: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var submissions = [];

  var AI_COLS  = [COL.Q1_AI,   COL.Q2_AI,   COL.Q3_AI,   COL.Q4_AI,   COL.Q5_AI];
  var OVR_COLS = [COL.Q1_OVR,  COL.Q2_OVR,  COL.Q3_OVR,  COL.Q4_OVR,  COL.Q5_OVR];
  var YAI_COLS = [COL.YGG1_AI, COL.YGG2_AI, COL.YGG3_AI];
  var YOVR_COLS= [COL.YGG1_OVR,COL.YGG2_OVR,COL.YGG3_OVR];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];

    var q1ai    = row[COL.Q1_AI - 1];
    var hasPerQ = (q1ai !== '' && q1ai !== null && q1ai !== undefined);

    var qScores = [];
    for (var qi = 0; qi < 5; qi++) {
      var ai  = row[AI_COLS[qi] - 1];
      var ovr = row[OVR_COLS[qi] - 1];
      if (ai !== '' && ai !== null && ai !== undefined) {
        qScores.push({
          aiScore:  Number(ai),
          override: (ovr !== '' && ovr !== null && ovr !== undefined) ? Number(ovr) : null,
          maxScore: OPEN_MAX_PER_Q
        });
      }
    }

    var yScores = [];
    for (var yi = 0; yi < 3; yi++) {
      var yai  = row[YAI_COLS[yi] - 1];
      var yovr = row[YOVR_COLS[yi] - 1];
      yScores.push({
        aiScore:  (yai !== '' && yai !== null && yai !== undefined) ? Number(yai) : 0,
        override: (yovr !== '' && yovr !== null && yovr !== undefined) ? Number(yovr) : null,
        maxScore: YGG_MAX_PER_Q
      });
    }

    var maxScore = Number(row[COL.MAX_SCORE - 1]) || 0;
    var openMax  = qScores.length * OPEN_MAX_PER_Q;
    var mcMax    = maxScore - openMax;

    submissions.push({
      timestamp:          String(row[COL.TIMESTAMP  - 1]),
      firstName:          String(row[COL.FIRST_NAME - 1]),
      lastName:           String(row[COL.LAST_NAME  - 1]),
      email:              String(row[COL.EMAIL       - 1]),
      class:              String(row[COL.CLASS       - 1]),
      set:                String(row[COL.SET         - 1]),
      mcScore:            Number(row[COL.MC_SCORE    - 1]) || 0,
      mcMax:              mcMax,
      openScore:          Number(row[COL.OPEN_SCORE  - 1]) || 0,
      openMax:            openMax,
      penalty:            Number(row[COL.PENALTY     - 1]) || 0,
      scoreAfterPenalty:  Number(row[COL.TOTAL_SCORE - 1]) || 0,
      maxScore:           maxScore,
      percentage:         Number(row[COL.PERCENTAGE  - 1]) || 0,
      finalGrade:         String(row[COL.FINAL_GRADE - 1]),
      bonus:              Number(row[COL.BONUS        - 1]) || 0,
      hasPerQuestionData: hasPerQ,
      questionScores:     qScores,
      yggScores:          yScores
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({submissions: submissions}))
    .setMimeType(ContentService.MimeType.JSON);
}

function shuffleIndices(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// ============================================================
// POST HANDLER
// ============================================================
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'override')      { return handleOverride(data); }
    if (data.action === 'updateConfig')  { return handleUpdateConfig(data); }
    return handleSubmission(data);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// HANDLE EXAM SUBMISSION
// ============================================================
function handleSubmission(data) {
  var openEnded    = data.openEnded    || [];
  var yggAnswers   = data.yggAnswers   || [];
  var mcAnswers    = data.mcAnswers    || [];
  var set          = data.set          || 'A';
  var mcScore      = Number(data.mcScore)       || 0;
  var penaltyPoints= Number(data.penaltyPoints) || 0;
  var tabSwitches  = Number(data.tabSwitches)   || 0;

  // Grade open-ended questions
  var openFeedback      = [];
  var openAIScores      = [];
  var totalOpenScore    = 0;
  var openFeedbackParts = [];

  for (var i = 0; i < openEnded.length; i++) {
    var q      = openEnded[i];
    var result = gradeWithGemini(q.text, q.rubric, q.points);
    openFeedback.push({questionId: q.questionId, score: result.score, maxScore: q.points, feedback: result.feedback});
    openAIScores.push(result.score);
    totalOpenScore += result.score;
    openFeedbackParts.push(q.questionId + ': ' + result.score + '/' + q.points + ' - ' + result.feedback);
  }

  // Grade Yggdrasil
  var yggFeedback      = [];
  var yggAIScores      = [];
  var yggScore         = 0;
  var yggFeedbackParts = [];
  var yggBonus         = 0;

  for (var j = 0; j < yggAnswers.length; j++) {
    var yq     = yggAnswers[j];
    var yResult= {score: 0, feedback: 'Not attempted.'};
    if (yq.text && yq.text.trim().length > 2) {
      yResult = gradeWithGemini(yq.text, yq.rubric, yq.points);
    }
    yggFeedback.push({questionId: yq.questionId, score: yResult.score, maxScore: yq.points, feedback: yResult.feedback});
    yggAIScores.push(yResult.score);
    yggScore += yResult.score;
    yggFeedbackParts.push(yq.questionId + ': ' + yResult.score + '/' + yq.points + ' - ' + yResult.feedback);
    if (yResult.score >= 0.6 * yq.points) { yggBonus += 0.3; }
  }

  // Calculate totals
  var mcMax   = 0;
  for (var mi = 0; mi < mcAnswers.length; mi++)  { mcMax   += mcAnswers[mi].points; }
  var openMax = 0;
  for (var oi = 0; oi < openEnded.length; oi++)  { openMax += openEnded[oi].points; }
  var totalMax = mcMax + openMax;

  var rawScore          = mcScore + totalOpenScore;
  var scoreAfterPenalty = Math.max(0, rawScore - penaltyPoints);
  var percentage        = totalMax > 0 ? Math.round((scoreAfterPenalty / totalMax) * 100) : 0;
  var effectiveBoundaries = loadEffectiveBoundaries();
  var baseGrade         = calculateGrade(percentage, set, effectiveBoundaries);
  var bonus             = Math.round(yggBonus * 10) / 10;
  var finalGradeNum     = Math.min(5.0, parseFloat(baseGrade) + bonus);
  var finalGrade        = finalGradeNum.toFixed(1);

  var timestamp = new Date().toISOString();

  writeSummaryToSheet({
    timestamp:    timestamp,
    firstName:    data.firstName,
    lastName:     data.lastName,
    email:        data.email || '',
    studentClass: data.class,
    set:          set,
    mcScore:      mcScore,
    openScore:    totalOpenScore,
    yggScore:     yggScore,
    penalty:      penaltyPoints,
    tabSwitches:  tabSwitches,
    scoreAfterPenalty: scoreAfterPenalty,
    maxScore:     totalMax,
    percentage:   percentage,
    finalGrade:   finalGrade,
    bonus:        bonus,
    openFeedback: openFeedbackParts.join('\n'),
    yggFeedback:  yggFeedbackParts.join('\n'),
    openAIScores: openAIScores,
    yggAIScores:  yggAIScores
  });

  writeDetailedAnswers({
    timestamp:    timestamp,
    email:        data.email || '',
    firstName:    data.firstName,
    lastName:     data.lastName,
    studentClass: data.class,
    set:          set,
    mcAnswers:    mcAnswers,
    openEnded:    openEnded,
    openFeedback: openFeedback,
    yggAnswers:   yggAnswers,
    yggFeedback:  yggFeedback
  });

  return ContentService
    .createTextOutput(JSON.stringify({
      success:    true,
      firstName:  data.firstName,
      lastName:   data.lastName,
      set:        set,
      totalScore: scoreAfterPenalty,
      maxScore:   totalMax,
      percentage: percentage,
      finalGrade: finalGrade,
      penalty:    penaltyPoints,
      bonus:      bonus,
      openFeedback: openFeedback,
      yggFeedback:  yggFeedback
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// WRITE DETAILED ANSWERS  (one row per question)
// ============================================================
function writeDetailedAnswers(d) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DETAILS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(DETAILS_SHEET);
    sheet.appendRow([
      'Timestamp','Email','Last Name','First Name','Class','Set',
      'Question_ID','Type','Question_Text','Student_Answer',
      'Correct_Answer','Is_Correct','AI_Score','Max_Score','AI_Feedback'
    ]);
  }

  var base = [d.timestamp, d.email, d.lastName, d.firstName, d.studentClass, d.set];

  var mcAnswers = d.mcAnswers || [];
  for (var i = 0; i < mcAnswers.length; i++) {
    var mc = mcAnswers[i];
    sheet.appendRow(base.concat([
      mc.questionId,
      'mc',
      mc.questionText  || '',
      mc.selectedText  || 'No answer',
      mc.correctText   || '',
      mc.correct ? 'TRUE' : 'FALSE',
      mc.correct ? mc.points : 0,
      mc.points,
      mc.correct ? 'Correct' : ('Incorrect. Correct answer: ' + (mc.correctText || ''))
    ]));
  }

  var openEnded    = d.openEnded    || [];
  var openFeedback = d.openFeedback || [];
  for (var j = 0; j < openEnded.length; j++) {
    var oe = openEnded[j];
    var fb = null;
    for (var fi = 0; fi < openFeedback.length; fi++) {
      if (openFeedback[fi].questionId === oe.questionId) { fb = openFeedback[fi]; break; }
    }
    sheet.appendRow(base.concat([
      oe.questionId,
      'openEnded',
      oe.questionText || '',
      oe.text         || 'No answer',
      '', '',
      fb ? fb.score : 0,
      oe.points,
      fb ? fb.feedback : ''
    ]));
  }

  var yggAnswers  = d.yggAnswers  || [];
  var yggFeedback = d.yggFeedback || [];
  for (var k = 0; k < yggAnswers.length; k++) {
    var yq  = yggAnswers[k];
    var yfb = null;
    for (var yi = 0; yi < yggFeedback.length; yi++) {
      if (yggFeedback[yi].questionId === yq.questionId) { yfb = yggFeedback[yi]; break; }
    }
    sheet.appendRow(base.concat([
      yq.questionId,
      'yggdrasil',
      yq.questionText || '',
      yq.text         || 'Not attempted',
      '', '',
      yfb ? yfb.score : 0,
      yq.points,
      yfb ? yfb.feedback : 'Not attempted'
    ]));
  }
}

// ============================================================
// GEMINI GRADING
// ============================================================
function gradeWithGemini(studentAnswer, rubric, maxPoints) {
  if (!studentAnswer || studentAnswer.trim().length < 2) {
    return {score: 0, feedback: 'No answer provided.'};
  }

  var prompt =
    'You are a strict but fair grading assistant for a high school Design & Technology class.\n\n' +
    'RUBRIC: ' + rubric + '\n' +
    'STUDENT ANSWER: ' + studentAnswer + '\n' +
    'MAX POINTS: ' + maxPoints + '\n\n' +
    'You MUST reply with ONLY these two lines — no markdown, no extra text:\n' +
    'SCORE: [integer from 0 to ' + maxPoints + ']\n' +
    'FEEDBACK: [1-2 sentence evaluation of the student answer]';

  var responseText = callGeminiAPI(prompt);

  var scoreMatch    = responseText.match(/SCORE:\s*(\d+)/i);
  var feedbackMatch = responseText.match(/FEEDBACK:?\s+([^\n].+)/i);
  if (!feedbackMatch) {
    feedbackMatch = responseText.match(/FEEDBACK:?\s*\n+([\s\S]+)/i);
  }

  var score    = scoreMatch ? Math.min(maxPoints, Math.max(0, parseInt(scoreMatch[1]))) : 0;
  var feedback = feedbackMatch ? feedbackMatch[1].trim() : '';

  if (!feedback) {
    feedback = responseText.replace(/SCORE:\s*\d+/i, '').replace(/FEEDBACK:?/i, '').trim();
  }
  if (!feedback) { feedback = 'Grading complete.'; }

  return {score: score, feedback: feedback};
}

function callGeminiAPI(prompt) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;
  var payload = JSON.stringify({
    contents: [{parts: [{text: prompt}]}],
    generationConfig: {temperature: 0.1, maxOutputTokens: 400}
  });
  var options = {method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true};
  var delays  = [2000, 4000, 8000];

  for (var attempt = 0; attempt <= delays.length; attempt++) {
    var response = UrlFetchApp.fetch(url, options);
    var code     = response.getResponseCode();

    if (code === 200) {
      var json = JSON.parse(response.getContentText());
      return json.candidates[0].content.parts[0].text;
    }

    if ((code === 429 || code === 503) && attempt < delays.length) {
      Utilities.sleep(delays[attempt]);
    } else {
      break;
    }
  }

  return 'SCORE: 0\nFEEDBACK: Grading service error.';
}

// ============================================================
// WRITE SUBMISSION SUMMARY TO SHEET
// ============================================================
function writeSummaryToSheet(d) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) { sheet = ss.insertSheet(SUBMISSIONS_SHEET); }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp','First Name','Last Name','Email','Class','Set',
      'MC Score','Open Score','Ygg Score',
      'Penalty','Tab Switches','Total Score','Max Score','Percentage','Final Grade','Bonus',
      'Open Feedback','Ygg Feedback',
      'Q1_AI','Q2_AI','Q3_AI','Q4_AI','Q5_AI',
      'Q1_Override','Q2_Override','Q3_Override','Q4_Override','Q5_Override',
      'YGG1_AI','YGG2_AI','YGG3_AI',
      'YGG1_Override','YGG2_Override','YGG3_Override'
    ]);
  }

  var row = new Array(34);
  for (var x = 0; x < 34; x++) { row[x] = ''; }

  row[COL.TIMESTAMP    - 1] = d.timestamp;
  row[COL.FIRST_NAME   - 1] = d.firstName;
  row[COL.LAST_NAME    - 1] = d.lastName;
  row[COL.EMAIL        - 1] = d.email;
  row[COL.CLASS        - 1] = d.studentClass;
  row[COL.SET          - 1] = d.set;
  row[COL.MC_SCORE     - 1] = d.mcScore;
  row[COL.OPEN_SCORE   - 1] = d.openScore;
  row[COL.YGG_SCORE    - 1] = d.yggScore;
  row[COL.PENALTY      - 1] = d.penalty;
  row[COL.TAB_SWITCHES - 1] = d.tabSwitches;
  row[COL.TOTAL_SCORE  - 1] = d.scoreAfterPenalty;
  row[COL.MAX_SCORE    - 1] = d.maxScore;
  row[COL.PERCENTAGE   - 1] = d.percentage;
  row[COL.FINAL_GRADE  - 1] = d.finalGrade;
  row[COL.BONUS        - 1] = d.bonus;
  row[COL.OPEN_FB      - 1] = d.openFeedback;
  row[COL.YGG_FB       - 1] = d.yggFeedback;

  var AI_COLS  = [COL.Q1_AI,   COL.Q2_AI,   COL.Q3_AI,   COL.Q4_AI,   COL.Q5_AI];
  var YAI_COLS = [COL.YGG1_AI, COL.YGG2_AI, COL.YGG3_AI];

  var oScores = d.openAIScores || [];
  for (var i = 0; i < oScores.length && i < 5; i++) { row[AI_COLS[i] - 1] = oScores[i]; }

  var yScores = d.yggAIScores || [];
  for (var j = 0; j < yScores.length && j < 3; j++) { row[YAI_COLS[j] - 1] = yScores[j]; }

  sheet.appendRow(row);
}

// ============================================================
// HANDLE OVERRIDE  (from admin.html)
// ============================================================
function handleOverride(data) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Sheet not found'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var allData  = sheet.getDataRange().getValues();
  var targetRow= -1;

  for (var i = 1; i < allData.length; i++) {
    if (String(allData[i][COL.TIMESTAMP - 1]) === String(data.timestamp)) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Submission not found'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var row      = allData[targetRow - 1];
  var qScores  = data.questionScores || [];
  var yScores  = data.yggScores      || [];

  var OVR_COLS = [COL.Q1_OVR,   COL.Q2_OVR,   COL.Q3_OVR,   COL.Q4_OVR,   COL.Q5_OVR];
  var YOVR_COLS= [COL.YGG1_OVR, COL.YGG2_OVR, COL.YGG3_OVR];

  for (var qi = 0; qi < 5; qi++) {
    var val = (qScores[qi] !== null && qScores[qi] !== undefined) ? qScores[qi] : '';
    row[OVR_COLS[qi] - 1] = val;
    sheet.getRange(targetRow, OVR_COLS[qi]).setValue(val);
  }
  for (var yi = 0; yi < 3; yi++) {
    var yval = (yScores[yi] !== null && yScores[yi] !== undefined) ? yScores[yi] : '';
    row[YOVR_COLS[yi] - 1] = yval;
    sheet.getRange(targetRow, YOVR_COLS[yi]).setValue(yval);
  }

  var updated = recalcRow(row, loadEffectiveBoundaries());

  sheet.getRange(targetRow, COL.OPEN_SCORE).setValue(updated.openScore);
  sheet.getRange(targetRow, COL.YGG_SCORE).setValue(updated.yggScore);
  sheet.getRange(targetRow, COL.TOTAL_SCORE).setValue(updated.totalScore);
  sheet.getRange(targetRow, COL.PERCENTAGE).setValue(updated.percentage);
  sheet.getRange(targetRow, COL.FINAL_GRADE).setValue(updated.finalGrade);
  sheet.getRange(targetRow, COL.BONUS).setValue(updated.bonus);

  return ContentService
    .createTextOutput(JSON.stringify({success: true, finalGrade: updated.finalGrade, percentage: updated.percentage}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// HANDLE CONFIG UPDATE
// ============================================================
function handleUpdateConfig(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Config sheet not found'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rows = sheet.getDataRange().getValues();
  var updates = data.updates || {};

  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][0]).trim();
    if (updates.hasOwnProperty(key)) {
      sheet.getRange(i + 1, 2).setValue(String(updates[key]));
      delete updates[key];
    }
  }
  for (var k in updates) {
    sheet.appendRow([k, String(updates[k])]);
  }
  return ContentService
    .createTextOutput(JSON.stringify({success: true}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// RECALCULATION HELPER
// ============================================================
function recalcRow(row, boundaries) {
  var set      = String(row[COL.SET - 1]);
  var mcScore  = Number(row[COL.MC_SCORE - 1])  || 0;
  var penalty  = Number(row[COL.PENALTY - 1])   || 0;
  var maxScore = Number(row[COL.MAX_SCORE - 1]) || 60;

  var AI_COLS  = [COL.Q1_AI,   COL.Q2_AI,   COL.Q3_AI,   COL.Q4_AI,   COL.Q5_AI];
  var OVR_COLS = [COL.Q1_OVR,  COL.Q2_OVR,  COL.Q3_OVR,  COL.Q4_OVR,  COL.Q5_OVR];
  var YAI_COLS = [COL.YGG1_AI, COL.YGG2_AI, COL.YGG3_AI];
  var YOVR_COLS= [COL.YGG1_OVR,COL.YGG2_OVR,COL.YGG3_OVR];

  var openScore = 0;
  for (var qi = 0; qi < 5; qi++) {
    var ai  = row[AI_COLS[qi] - 1];
    var ovr = row[OVR_COLS[qi] - 1];
    if (ai !== '' && ai !== null && ai !== undefined) {
      var effective = (ovr !== '' && ovr !== null && ovr !== undefined) ? Number(ovr) : Number(ai);
      openScore += effective;
    }
  }

  var yggScore = 0;
  var yggBonus = 0;
  for (var yi = 0; yi < 3; yi++) {
    var yai  = row[YAI_COLS[yi] - 1];
    var yovr = row[YOVR_COLS[yi] - 1];
    if (yai !== '' && yai !== null && yai !== undefined) {
      var yEff = (yovr !== '' && yovr !== null && yovr !== undefined) ? Number(yovr) : Number(yai);
      yggScore += yEff;
      if (yEff >= 0.6 * YGG_MAX_PER_Q) { yggBonus += 0.3; }
    }
  }

  var bonus         = Math.round(yggBonus * 10) / 10;
  var totalScore    = Math.max(0, mcScore + openScore - penalty);
  var percentage    = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  var baseGrade     = calculateGrade(percentage, set, boundaries);
  var finalGradeNum = Math.min(5.0, parseFloat(baseGrade) + bonus);

  return {
    openScore:  openScore,
    yggScore:   yggScore,
    totalScore: totalScore,
    percentage: percentage,
    finalGrade: finalGradeNum.toFixed(1),
    bonus:      bonus
  };
}

// ============================================================
// GRADE LOOKUP
// ============================================================
function calculateGrade(percentage, set, boundaries) {
  var bds = (boundaries && boundaries[set]) ? boundaries[set] : (GRADE_BOUNDARIES[set] || GRADE_BOUNDARIES['A']);
  for (var i = 0; i < bds.length; i++) {
    if (percentage >= bds[i].min) { return bds[i].grade; }
  }
  return '1.0';
}

// ============================================================
// MENU: RECALCULATE ALL ROWS
// ============================================================
function recalculateWithOverrides() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) { SpreadsheetApp.getUi().alert('No Submissions sheet found.'); return; }

  var data    = sheet.getDataRange().getValues();
  var changed = 0;
  var effectiveBoundaries = loadEffectiveBoundaries();

  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var q1ai = row[COL.Q1_AI - 1];
    if (q1ai === '' || q1ai === null || q1ai === undefined) { continue; }

    var updated  = recalcRow(row, effectiveBoundaries);
    var sheetRow = i + 1;

    sheet.getRange(sheetRow, COL.OPEN_SCORE).setValue(updated.openScore);
    sheet.getRange(sheetRow, COL.YGG_SCORE).setValue(updated.yggScore);
    sheet.getRange(sheetRow, COL.TOTAL_SCORE).setValue(updated.totalScore);
    sheet.getRange(sheetRow, COL.PERCENTAGE).setValue(updated.percentage);
    sheet.getRange(sheetRow, COL.FINAL_GRADE).setValue(updated.finalGrade);
    sheet.getRange(sheetRow, COL.BONUS).setValue(updated.bonus);
    changed++;
  }

  SpreadsheetApp.getUi().alert('Done. Recalculated ' + changed + ' submission(s).');
}

// ============================================================
// MENU: BACKFILL AI SCORES
// ============================================================
function backfillAIScores() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) { SpreadsheetApp.getUi().alert('No Submissions sheet found.'); return; }

  var data   = sheet.getDataRange().getValues();
  var filled = 0;
  var regex  = /([A-Z]+_\d+):\s*(\d+)\/(\d+)/g;

  var AI_COLS  = [COL.Q1_AI,   COL.Q2_AI,   COL.Q3_AI,   COL.Q4_AI,   COL.Q5_AI];
  var YAI_COLS = [COL.YGG1_AI, COL.YGG2_AI, COL.YGG3_AI];

  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var q1ai = row[COL.Q1_AI - 1];
    if (q1ai !== '' && q1ai !== null && q1ai !== undefined) { continue; }

    var openFb = String(row[COL.OPEN_FB - 1] || '');
    var yggFb  = String(row[COL.YGG_FB  - 1] || '');
    if (!openFb) { continue; }

    var sheetRow = i + 1;
    var qIdx = 0;
    var yIdx = 0;
    var match;

    regex.lastIndex = 0;
    while ((match = regex.exec(openFb)) !== null) {
      var id = match[1];
      if (id.indexOf('YGG') !== -1) { continue; }
      if (qIdx < 5) {
        sheet.getRange(sheetRow, AI_COLS[qIdx]).setValue(parseInt(match[2]));
        qIdx++;
      }
    }

    regex.lastIndex = 0;
    while ((match = regex.exec(yggFb)) !== null) {
      if (yIdx < 3) {
        sheet.getRange(sheetRow, YAI_COLS[yIdx]).setValue(parseInt(match[2]));
        yIdx++;
      }
    }

    if (qIdx > 0) { filled++; }
  }

  SpreadsheetApp.getUi().alert('Done. Backfilled AI scores for ' + filled + ' submission(s).');
}

// ============================================================
// SETUP
// ============================================================
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG_SHEET))    { createConfigSheet(ss);    console.log('Config sheet created.'); }
  else                                      { console.log('Config sheet already exists.'); }
  if (!ss.getSheetByName(QUESTIONS_SHEET)) { createQuestionsSheet(ss); console.log('Questions sheet created.'); }
  else                                      { console.log('Questions sheet already exists.'); }
  console.log('Setup complete.');
}

function createConfigSheet(ss) {
  if (!ss) { ss = SpreadsheetApp.getActiveSpreadsheet(); }
  var sheet = ss.insertSheet(CONFIG_SHEET);
  sheet.appendRow(['exam_title',            'Exam']);
  sheet.appendRow(['exam_subtitle',         'Select your question set to begin.']);
  sheet.appendRow(['class_options',         '10A,10B,10C']);
  sheet.appendRow(['exam_duration_minutes', '60']);
  sheet.appendRow(['exam_active',           'true']);
  sheet.appendRow(['grade_boundaries_A',    '2.3:85,2.0:70,1.7:50,1.3:35,1.0:0']);
  sheet.appendRow(['grade_boundaries_B',    '3.3:85,3.0:75,2.7:65,2.3:55,2.0:45,1.7:35,1.3:20,1.0:0']);
  sheet.appendRow(['grade_boundaries_C',    '4.0:90,3.7:80,3.3:70,3.0:60,2.7:50,2.3:40,2.0:30,1.7:20,1.3:10,1.0:0']);
  return sheet;
}

function createQuestionsSheet(ss) {
  if (!ss) { ss = SpreadsheetApp.getActiveSpreadsheet(); }
  var sheet = ss.insertSheet(QUESTIONS_SHEET);
  sheet.appendRow(['Set','ID','Section','Type','Points','Text','Option_A','Option_B','Option_C','Option_D','CorrectIndex','Rubric']);
  return sheet;
}
