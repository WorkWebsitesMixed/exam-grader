// ============================================================
// Code.gs  -  Exam Auto-Grader Backend
// Paste this entire file into your Google Apps Script editor.
// Store your Anthropic (Claude) API key in Apps Script Project Settings >
// Script Properties with key name: ANTHROPIC_API_KEY
// Then deploy as a new Web App version (Anyone can access).
// ============================================================

var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || '';
var GRADING_MODEL     = 'claude-sonnet-4-6';  // flip to 'claude-opus-4-8' for maximum feedback quality
var GOOGLE_CLIENT_ID  = '878760918876-psduvcg9tsudtggqoqk0cf02n63d5mou.apps.googleusercontent.com';
var SUBMISSIONS_SHEET = 'Submissions';
var DETAILS_SHEET     = 'Detailed_Answers';
var QUESTIONS_SHEET   = 'Questions';
var CONFIG_SHEET      = 'Config';

var OPEN_MAX_PER_Q = 8;

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
  PENALTY:      9,
  TAB_SWITCHES: 10,
  TOTAL_SCORE:  11,
  MAX_SCORE:    12,
  PERCENTAGE:   13,
  FINAL_GRADE:  14,
  OPEN_FB:      15,
  Q1_AI:        16,
  Q2_AI:        17,
  Q3_AI:        18,
  Q4_AI:        19,
  Q5_AI:        20,
  Q1_OVR:       21,
  Q2_OVR:       22,
  Q3_OVR:       23,
  Q4_OVR:       24,
  Q5_OVR:       25,
  EXAM_ID:      26
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
// SAFE JSON — escapes non-ASCII to \uXXXX so encoding never matters
// ============================================================
function safeJson(obj) {
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, function(c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

// ============================================================
// ADMIN AUTH HELPERS
// ============================================================
function getAdminPassword() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) return '';
  var rows = sheet.getDataRange().getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === 'admin_password') { return String(rows[i][1]); }
  }
  return '';
}

function checkAdminAuth(providedPassword) {
  var stored = getAdminPassword();
  if (!stored) return true; // no password configured = open
  return String(providedPassword) === stored;
}

function handleVerifyAdmin(data) {
  var ok = checkAdminAuth(data.password || '');
  return ContentService
    .createTextOutput(JSON.stringify({success: ok, error: ok ? null : 'Incorrect password'}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GOOGLE TOKEN VERIFICATION
// ============================================================
function verifyGoogleToken(idToken) {
  try {
    var url      = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    var response = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    if (response.getResponseCode() !== 200) { return null; }
    var info = JSON.parse(response.getContentText());
    if (info.aud !== GOOGLE_CLIENT_ID && info.azp !== GOOGLE_CLIENT_ID) { return null; }
    return info.email ? info : null;
  } catch(e) { return null; }
}

function handleMyResults(data) {
  var idToken = String(data.idToken || '');
  if (!idToken) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'No token provided'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var tokenInfo = verifyGoogleToken(idToken);
  if (!tokenInfo) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Invalid or expired token'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return getMyResultsResponse(tokenInfo.email);
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
  if (action === 'config') { return getConfigResponse(); }
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

  var questions = {A: [], B: [], C: []};

  var activeExamId = String(config['exam_id'] || '').trim();

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
    var rubric  = String(row[11]).trim();
    var qExam   = String(row[12] !== undefined ? row[12] : '').trim();
    var imageId = String(row[13] !== undefined ? row[13] : '').trim();

    if (!set || !id || !text) { continue; }
    // Empty Exam field = belongs to all exams; non-empty must match active exam_id
    if (qExam && activeExamId && qExam !== activeExamId) { continue; }

    // NOTE: rubric / accepted-answers are intentionally NOT sent to students.
    var q = {id: id, section: section, type: type, points: points, text: text, imageUrl: driveImageUrl_(imageId)};

    if (type === 'mc') {
      var opts = [optA, optB, optC, optD];
      var indices = [0, 1, 2, 3];
      shuffleIndices(indices);
      q.options  = opts;
      q.shuffled = indices;
      // correctIndex intentionally NOT sent to client — graded server-side
    }

    if (questions[set] !== undefined) {
      questions[set].push(q);
    }
  }

  // Question bank sampling — randomize and/or limit independently
  var questionsPerSet = parseInt(config['questions_per_set'] || '0', 10);
  var oePerSet        = parseInt(config['oe_per_set']        || '0', 10);
  var randomizeBank   = (config['randomize_questions'] || 'false').toLowerCase() === 'true';
  ['A', 'B', 'C'].forEach(function(s) {
    if (questionsPerSet > 0 && oePerSet > 0) {
      // Split into typed pools, shuffle each independently if randomize is on
      var mcPool = questions[s].filter(function(q) { return q.type === 'mc'; });
      var oePool = questions[s].filter(function(q) { return q.type !== 'mc'; });
      if (randomizeBank) {
        for (var mi = mcPool.length - 1; mi > 0; mi--) {
          var mj = Math.floor(Math.random() * (mi + 1));
          var mt = mcPool[mi]; mcPool[mi] = mcPool[mj]; mcPool[mj] = mt;
        }
        for (var oi = oePool.length - 1; oi > 0; oi--) {
          var oj = Math.floor(Math.random() * (oi + 1));
          var ot = oePool[oi]; oePool[oi] = oePool[oj]; oePool[oj] = ot;
        }
      }
      var oeTake   = Math.min(oePerSet, oePool.length);
      var mcTake   = Math.min(Math.max(0, questionsPerSet - oeTake), mcPool.length);
      var selected = oePool.slice(0, oeTake).concat(mcPool.slice(0, mcTake));
      // Shuffle the combined result so OE and MC are interleaved
      if (randomizeBank) {
        for (var si = selected.length - 1; si > 0; si--) {
          var sj = Math.floor(Math.random() * (si + 1));
          var st = selected[si]; selected[si] = selected[sj]; selected[sj] = st;
        }
      }
      questions[s] = selected;
    } else {
      if (randomizeBank) {
        for (var i = questions[s].length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = questions[s][i]; questions[s][i] = questions[s][j]; questions[s][j] = tmp;
        }
      }
      if (questionsPerSet > 0 && questions[s].length > questionsPerSet) {
        questions[s] = questions[s].slice(0, questionsPerSet);
      }
    }
  });

  // Strip admin_password before sending to students
  var safeConfig = {};
  for (var ck in config) {
    if (ck !== 'admin_password') { safeConfig[ck] = config[ck]; }
  }

  return ContentService
    .createTextOutput(JSON.stringify({success: true, questions: questions, config: safeConfig}))
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
  var adminPw = config['admin_password'] || '';
  delete config['admin_password'];
  config['admin_password_required'] = adminPw !== '' ? 'true' : 'false';
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
    .createTextOutput(safeJson({success: true, submissions: submissions}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GET: DETAILS FOR ONE SUBMISSION  (admin modal lazy-load)
// ============================================================
function getDetailsResponse(timestamp) {
  if (!timestamp) {
    return ContentService
      .createTextOutput(safeJson({details: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DETAILS_SHEET);
  if (!sheet) {
    return ContentService
      .createTextOutput(safeJson({details: []}))
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
    .createTextOutput(safeJson({details: details}))
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
      .createTextOutput(safeJson({submissions: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var submissions = [];

  var AI_COLS  = [COL.Q1_AI,  COL.Q2_AI,  COL.Q3_AI,  COL.Q4_AI,  COL.Q5_AI];
  var OVR_COLS = [COL.Q1_OVR, COL.Q2_OVR, COL.Q3_OVR, COL.Q4_OVR, COL.Q5_OVR];

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
      examId:             String(row[COL.EXAM_ID    - 1] || ''),
      hasPerQuestionData: hasPerQ,
      questionScores:     qScores
    });
  }

  return ContentService
    .createTextOutput(safeJson({submissions: submissions}))
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

    // verifyAdmin does its own auth check
    if (data.action === 'verifyAdmin')     { return handleVerifyAdmin(data); }
    if (data.action === 'myresults')       { return handleMyResults(data); }
    if (data.action === 'checkDuplicate')  { return handleCheckDuplicate(data); }

    // All admin actions require server-side password verification
    var adminActions = ['submissions', 'details', 'adminQuestions', 'addQuestion', 'updateQuestion', 'deleteQuestion', 'override', 'updateConfig', 'deleteSubmission', 'recalculate', 'regrademc', 'resendEmails', 'mcDistractors', 'uploadImage'];
    if (adminActions.indexOf(data.action) !== -1) {
      if (!checkAdminAuth(data.adminPassword || '')) {
        return ContentService
          .createTextOutput(JSON.stringify({success: false, error: 'Unauthorized'}))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (data.action === 'submissions')      { return getSubmissionsResponse(); }
    if (data.action === 'details')          { return getDetailsResponse(data.timestamp || ''); }
    if (data.action === 'adminQuestions')   { return getAdminQuestionsResponse(); }
    if (data.action === 'addQuestion')      { return handleAddQuestion(data); }
    if (data.action === 'updateQuestion')   { return handleUpdateQuestion(data); }
    if (data.action === 'deleteQuestion')   { return handleDeleteQuestion(data); }
    if (data.action === 'override')         { return handleOverride(data); }
    if (data.action === 'updateConfig')     { return handleUpdateConfig(data); }
    if (data.action === 'deleteSubmission') { return handleDelete(data); }
    if (data.action === 'recalculate')      { return handleBulkRecalc(); }
    if (data.action === 'regrademc')        { return handleRegradeAllMC(); }
    if (data.action === 'resendEmails')     { return handleResendEmails(data); }
    if (data.action === 'mcDistractors')    { return handleMcDistractors(); }
    if (data.action === 'uploadImage')      { return handleUploadImage(data); }
    return handleSubmission(data);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// HANDLE DUPLICATE CHECK  (called before exam starts)
// ============================================================
function handleCheckDuplicate(data) {
  var email = String(data.email || '').toLowerCase().trim();
  var set   = String(data.set   || '');

  if (data.idToken) {
    var tokenInfo = verifyGoogleToken(data.idToken);
    if (tokenInfo && tokenInfo.email) { email = tokenInfo.email.toLowerCase().trim(); }
  }

  if (!email || !set) {
    return ContentService
      .createTextOutput(JSON.stringify({duplicate: false}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Read active exam_id from Config
  var activeExamId = '';
  var cfgSheet = ss.getSheetByName(CONFIG_SHEET);
  if (cfgSheet) {
    var cfgRows = cfgSheet.getDataRange().getValues();
    for (var ci = 0; ci < cfgRows.length; ci++) {
      if (String(cfgRows[ci][0]).trim() === 'exam_id') {
        activeExamId = String(cfgRows[ci][1]).trim();
        break;
      }
    }
  }

  var sub = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (sub && sub.getLastRow() > 1) {
    var existing = sub.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      var rowExam = String(existing[i][COL.EXAM_ID - 1] || '').trim();
      if (String(existing[i][COL.EMAIL - 1]).toLowerCase().trim() === email &&
          String(existing[i][COL.SET   - 1]) === set &&
          rowExam === activeExamId) {
        return ContentService
          .createTextOutput(JSON.stringify({duplicate: true}))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({duplicate: false}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// HANDLE EXAM SUBMISSION
// ============================================================
function handleSubmission(data) {
  var openEnded    = data.openEnded || [];
  var mcAnswers    = data.mcAnswers || [];  // [{questionId, questionText, selectedText}]
  var set          = data.set           || 'A';
  var email        = String(data.email  || '').toLowerCase().trim();
  var penaltyPoints = Math.max(0, Math.min(Number(data.penaltyPoints) || 0, 4));
  var tabSwitches   = Math.max(0, Math.min(Number(data.tabSwitches)  || 0, 10));

  // Override email with server-verified identity when token is present
  if (data.idToken) {
    var tokenInfo = verifyGoogleToken(data.idToken);
    if (tokenInfo && tokenInfo.email) { email = tokenInfo.email.toLowerCase().trim(); }
  }

  // Read active exam_id from Config
  var ss2 = SpreadsheetApp.getActiveSpreadsheet();
  var activeExamId = '';
  var cfgSheet2 = ss2.getSheetByName(CONFIG_SHEET);
  if (cfgSheet2) {
    var cfgData2 = cfgSheet2.getDataRange().getValues();
    for (var ci2 = 0; ci2 < cfgData2.length; ci2++) {
      if (String(cfgData2[ci2][0]).trim() === 'exam_id') {
        activeExamId = String(cfgData2[ci2][1]).trim();
        break;
      }
    }
  }

  // Load all questions for server-side grading (MC correctness + authoritative points)
  var qSheet = ss2.getSheetByName(QUESTIONS_SHEET);
  var questionMap = {};
  if (qSheet) {
    var qData = qSheet.getDataRange().getValues();
    for (var qi = 1; qi < qData.length; qi++) {
      var qr = qData[qi];
      var qtype = String(qr[3]).trim();
      var qid   = String(qr[1]).trim();
      if (!qid) { continue; }
      if (qtype === 'mc') {
        var opts = [String(qr[6]).trim(), String(qr[7]).trim(), String(qr[8]).trim(), String(qr[9]).trim()];
        var cidx = Number(qr[10]) - 1;  // CSV is 1-based (1=A…4=D), opts[] is 0-based
        questionMap[qid] = {type: 'mc', correctText: opts[cidx], points: Number(qr[4])};
      } else {
        questionMap[qid] = {type: qtype, points: Number(qr[4]), rubric: String(qr[11]).trim()};
      }
    }
  }

  // Re-grade MC answers server-side
  var mcScore = 0;
  var mcFeedback = [];
  var verifiedMcAnswers = [];
  for (var mi = 0; mi < mcAnswers.length; mi++) {
    var mc = mcAnswers[mi];
    var qInfo = questionMap[mc.questionId];
    var selectedText = String(mc.selectedText || 'No answer').trim();
    var correctText  = qInfo ? qInfo.correctText : '';
    var mcPoints     = qInfo ? qInfo.points : 0;
    var correct      = (qInfo && selectedText !== 'No answer' && selectedText === correctText);
    if (correct) { mcScore += mcPoints; }
    mcFeedback.push({questionId: mc.questionId, questionText: mc.questionText || '', correct: correct, selectedText: selectedText, correctText: correctText, earned: correct ? mcPoints : 0, points: mcPoints});
    verifiedMcAnswers.push({questionId: mc.questionId, questionText: mc.questionText || '', selectedText: selectedText, correctText: correctText, correct: correct, points: mcPoints});
  }

  // Duplicate guard — one submission per email + set + exam
  if (email) {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var sub = ss.getSheetByName(SUBMISSIONS_SHEET);
    if (sub && sub.getLastRow() > 1) {
      var existing = sub.getDataRange().getValues();
      for (var di = 1; di < existing.length; di++) {
        var rowExam = String(existing[di][COL.EXAM_ID - 1] || '').trim();
        if (String(existing[di][COL.EMAIL - 1]).toLowerCase().trim() === email &&
            String(existing[di][COL.SET   - 1]) === set &&
            rowExam === activeExamId) {
          return ContentService
            .createTextOutput(JSON.stringify({success: false, duplicate: true}))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }
  }

  // Grade open-ended questions using authoritative points from sheet
  var openFeedback      = [];
  var openAIScores      = [];
  var totalOpenScore    = 0;
  var openFeedbackParts = [];

  for (var i = 0; i < openEnded.length; i++) {
    var q          = openEnded[i];
    var qInfoOe    = questionMap[q.questionId];
    var authPoints = (qInfoOe ? qInfoOe.points : 0) || q.points;
    var rubricText = qInfoOe ? qInfoOe.rubric : (q.rubric || '');
    var result     = (qInfoOe && qInfoOe.type === 'short')
                     ? gradeShortAnswer(q.text, rubricText, authPoints)
                     : gradeOpenEnded(q.text, rubricText, authPoints);
    openFeedback.push({questionId: q.questionId, questionText: q.questionText || '', studentAnswer: q.text || '', score: result.score, maxScore: authPoints, feedback: result.feedback});
    openAIScores.push(result.score);
    totalOpenScore += result.score;
    openFeedbackParts.push(q.questionId + ': ' + result.score + '/' + authPoints + ' - ' + result.feedback);
  }

  // Calculate totals — both from server-verified data, not client
  var mcMax   = mcFeedback.reduce(function(s, f) { return s + f.points; }, 0);
  var openMax = openFeedback.reduce(function(s, f) { return s + f.maxScore; }, 0);
  var totalMax = mcMax + openMax;

  var rawScore          = mcScore + totalOpenScore;
  var scoreAfterPenalty = Math.max(0, rawScore - penaltyPoints);
  var percentage        = totalMax > 0 ? Math.round((scoreAfterPenalty / totalMax) * 100) : 0;
  var effectiveBoundaries = loadEffectiveBoundaries();
  var finalGrade        = calculateGrade(percentage, set, effectiveBoundaries);

  var timestamp = new Date().toISOString();

  writeSummaryToSheet({
    timestamp:    timestamp,
    firstName:    data.firstName,
    lastName:     data.lastName,
    email:        data.email || '',
    studentClass: data.class,
    set:          set,
    examId:       activeExamId,
    mcScore:      mcScore,
    openScore:    totalOpenScore,
    penalty:      penaltyPoints,
    tabSwitches:  tabSwitches,
    scoreAfterPenalty: scoreAfterPenalty,
    maxScore:     totalMax,
    percentage:   percentage,
    finalGrade:   finalGrade,
    openFeedback: openFeedbackParts.join('\n'),
    openAIScores: openAIScores
  });

  writeDetailedAnswers({
    timestamp:    timestamp,
    email:        data.email || '',
    firstName:    data.firstName,
    lastName:     data.lastName,
    studentClass: data.class,
    set:          set,
    mcAnswers:    verifiedMcAnswers,
    openEnded:    openEnded,
    openFeedback: openFeedback
  });

  if (email) {
    sendResultsEmail({
      email:       email,
      firstName:   data.firstName,
      lastName:    data.lastName,
      set:         set,
      finalGrade:  finalGrade,
      percentage:  percentage,
      totalScore:  scoreAfterPenalty,
      maxScore:    totalMax,
      penalty:     penaltyPoints,
      mcFeedback:  mcFeedback,
      openFeedback: openFeedback
    });
  }

  return ContentService
    .createTextOutput(safeJson({
      success:      true,
      firstName:    data.firstName,
      lastName:     data.lastName,
      set:          set,
      totalScore:   scoreAfterPenalty,
      maxScore:     totalMax,
      percentage:   percentage,
      finalGrade:   finalGrade,
      penalty:      penaltyPoints,
      openFeedback: openFeedback,
      mcFeedback:   mcFeedback
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

}

// ============================================================
// OPEN-ENDED GRADING  (Claude / Anthropic Messages API)
// ============================================================
function gradeOpenEnded(studentAnswer, rubric, maxPoints) {
  if (!studentAnswer || studentAnswer.trim().length < 2) {
    return {score: 0, feedback: 'No answer provided.'};
  }

  var system =
    'You are an experienced, fair examiner grading a high-school Design & Technology ' +
    'exam answer against a marking rubric. Award partial marks wherever the rubric allows. ' +
    'Judge only what the student actually wrote.';

  var userPrompt =
    'RUBRIC:\n' + rubric + '\n\n' +
    'STUDENT ANSWER:\n' + studentAnswer + '\n\n' +
    'MAXIMUM MARKS: ' + maxPoints + '\n\n' +
    'Grade the answer, then respond in EXACTLY this format and nothing else:\n' +
    'SCORE: <integer from 0 to ' + maxPoints + '>\n' +
    'FEEDBACK: <one detailed paragraph written directly to the student. Say what they got ' +
    'right, what was missing or incorrect, and specifically what topics or concepts they ' +
    'should review to improve. Be precise and encouraging, and refer to what they actually wrote.>';

  var responseText = callClaudeAPI(system, userPrompt);

  var scoreMatch    = responseText.match(/SCORE:\s*(\d+)/i);
  var feedbackMatch = responseText.match(/FEEDBACK:?\s+([\s\S]+)/i);

  var score    = scoreMatch ? Math.min(maxPoints, Math.max(0, parseInt(scoreMatch[1], 10))) : 0;
  var feedback = feedbackMatch ? feedbackMatch[1].trim() : '';

  if (!feedback) {
    feedback = responseText.replace(/SCORE:\s*\d+/i, '').replace(/FEEDBACK:?/i, '').trim();
  }
  if (!feedback) { feedback = 'Grading complete.'; }

  return {score: score, feedback: feedback};
}

// Short-answer grading — exact normalized match against accepted answers
// (comma-separated, stored in the Rubric column). No AI call.
function gradeShortAnswer(studentAnswer, acceptedCsv, maxPoints) {
  var ans = normalizeShort_(studentAnswer);
  if (!ans) { return {score: 0, feedback: 'No answer provided.'}; }
  var list = String(acceptedCsv || '').split(',');
  for (var i = 0; i < list.length; i++) {
    var acc = normalizeShort_(list[i]);
    if (acc && acc === ans) {
      return {score: maxPoints, feedback: 'Correct.'};
    }
  }
  return {score: 0, feedback: 'Incorrect. Accepted answer(s): ' + String(acceptedCsv || '').trim() + '.'};
}

function normalizeShort_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function callClaudeAPI(systemPrompt, userPrompt) {
  var url = 'https://api.anthropic.com/v1/messages';
  var payload = JSON.stringify({
    model: GRADING_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{role: 'user', content: userPrompt}]
  });
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: payload,
    muteHttpExceptions: true
  };
  var delays = [2000, 4000, 8000];

  for (var attempt = 0; attempt <= delays.length; attempt++) {
    var response = UrlFetchApp.fetch(url, options);
    var code     = response.getResponseCode();

    if (code === 200) {
      var json   = JSON.parse(response.getContentText());
      var blocks = json.content || [];
      for (var b = 0; b < blocks.length; b++) {
        if (blocks[b].type === 'text' && blocks[b].text) { return blocks[b].text; }
      }
      return 'SCORE: 0\nFEEDBACK: Grading produced no text (the request may have been declined).';
    }

    if ((code === 429 || code >= 500) && attempt < delays.length) {
      Utilities.sleep(delays[attempt]);
    } else if (code === 401 || code === 403) {
      return 'SCORE: 0\nFEEDBACK: Grading unavailable (API key not configured or invalid).';
    } else {
      break;
    }
  }

  return 'SCORE: 0\nFEEDBACK: Grading service temporarily unavailable.';
}

// ============================================================
// PHASE 1 TEST — run manually (editor: select testClaudeGrading, press Run).
// Verifies the Claude call + paragraph feedback. View output in the
// Execution log. First run will ask you to authorize external requests.
// Safe to delete once Phase 1 is confirmed working.
// ============================================================
function testClaudeGrading() {
  var rubric = 'Award 1 mark for identifying that the structure is triangulated / a triangle (truss). ' +
               'Award a 2nd mark for explaining that a triangle cannot change shape / deform under load, ' +
               'so it stays rigid. Maximum 2 marks.';
  var answer = 'It is a triangle shape so it is strong and does not move when you push it.';
  var result = gradeOpenEnded(answer, rubric, 2);
  Logger.log('MODEL: ' + GRADING_MODEL);
  Logger.log('SCORE: ' + result.score + ' / 2');
  Logger.log('FEEDBACK: ' + result.feedback);
  return result;
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
      'MC Score','Open Score',
      'Penalty','Tab Switches','Total Score','Max Score','Percentage','Final Grade',
      'Open Feedback',
      'Q1_AI','Q2_AI','Q3_AI','Q4_AI','Q5_AI',
      'Q1_Override','Q2_Override','Q3_Override','Q4_Override','Q5_Override',
      'Exam_ID'
    ]);
  }

  var row = new Array(26);
  for (var x = 0; x < 26; x++) { row[x] = ''; }

  row[COL.TIMESTAMP    - 1] = d.timestamp;
  row[COL.FIRST_NAME   - 1] = d.firstName;
  row[COL.LAST_NAME    - 1] = d.lastName;
  row[COL.EMAIL        - 1] = d.email;
  row[COL.CLASS        - 1] = d.studentClass;
  row[COL.SET          - 1] = d.set;
  row[COL.MC_SCORE     - 1] = d.mcScore;
  row[COL.OPEN_SCORE   - 1] = d.openScore;
  row[COL.PENALTY      - 1] = d.penalty;
  row[COL.TAB_SWITCHES - 1] = d.tabSwitches;
  row[COL.TOTAL_SCORE  - 1] = d.scoreAfterPenalty;
  row[COL.MAX_SCORE    - 1] = d.maxScore;
  row[COL.PERCENTAGE   - 1] = d.percentage;
  row[COL.FINAL_GRADE  - 1] = d.finalGrade;
  row[COL.OPEN_FB      - 1] = d.openFeedback;

  var AI_COLS = [COL.Q1_AI, COL.Q2_AI, COL.Q3_AI, COL.Q4_AI, COL.Q5_AI];

  var oScores = d.openAIScores || [];
  for (var i = 0; i < oScores.length && i < 5; i++) { row[AI_COLS[i] - 1] = oScores[i]; }

  row[COL.EXAM_ID - 1] = d.examId || '';

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

  var row     = allData[targetRow - 1];
  var qScores = data.questionScores || [];

  var OVR_COLS = [COL.Q1_OVR, COL.Q2_OVR, COL.Q3_OVR, COL.Q4_OVR, COL.Q5_OVR];

  for (var qi = 0; qi < 5; qi++) {
    var val = (qScores[qi] !== null && qScores[qi] !== undefined) ? qScores[qi] : '';
    row[OVR_COLS[qi] - 1] = val;
    sheet.getRange(targetRow, OVR_COLS[qi]).setValue(val);
  }

  var updated = recalcRow(row, loadEffectiveBoundaries());

  sheet.getRange(targetRow, COL.OPEN_SCORE).setValue(updated.openScore);
  sheet.getRange(targetRow, COL.TOTAL_SCORE).setValue(updated.totalScore);
  sheet.getRange(targetRow, COL.PERCENTAGE).setValue(updated.percentage);
  sheet.getRange(targetRow, COL.FINAL_GRADE).setValue(updated.finalGrade);

  return ContentService
    .createTextOutput(JSON.stringify({success: true, finalGrade: updated.finalGrade, percentage: updated.percentage, openScore: updated.openScore}))
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

  // Don't overwrite the password with a blank value (blank = "keep current")
  if (updates.hasOwnProperty('admin_password') && updates['admin_password'] === '') {
    delete updates['admin_password'];
  }

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
// HANDLE DELETE SUBMISSION  (from admin.html)
// ============================================================
function handleDelete(data) {
  var ts  = String(data.timestamp || '');
  if (!ts) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'No timestamp provided'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sub = ss.getSheetByName(SUBMISSIONS_SHEET);
  var det = ss.getSheetByName(DETAILS_SHEET);

  if (sub) {
    var subData = sub.getDataRange().getValues();
    for (var i = subData.length - 1; i >= 1; i--) {
      if (String(subData[i][COL.TIMESTAMP - 1]) === ts) {
        sub.deleteRow(i + 1);
        break;
      }
    }
  }

  if (det && det.getLastRow() > 1) {
    var detData = det.getDataRange().getValues();
    for (var j = detData.length - 1; j >= 1; j--) {
      if (String(detData[j][DCOL.TIMESTAMP]) === ts) {
        det.deleteRow(j + 1);
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({success: true}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// ============================================================
// RESULTS EMAIL
// ============================================================
function escapeHtmlGas(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendResultsEmail(p) {
  try {
    var examTitle = 'Exam';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cfg = ss.getSheetByName(CONFIG_SHEET);
    if (cfg) {
      var cfgRows = cfg.getDataRange().getValues();
      for (var ci = 0; ci < cfgRows.length; ci++) {
        if (String(cfgRows[ci][0]).trim() === 'exam_title' && cfgRows[ci][1]) {
          examTitle = String(cfgRows[ci][1]).trim();
          break;
        }
      }
    }

    var gradeColor  = '#27AE60';
    var subject     = examTitle + ' — Your Results';

    var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0F172A;">' +

      // Header
      '<div style="background:#1F4E78;color:white;padding:28px 24px;border-radius:8px 8px 0 0;">' +
        '<h1 style="margin:0;font-size:22px;">' + escapeHtmlGas(examTitle) + '</h1>' +
        '<p style="margin:6px 0 0;opacity:0.85;font-size:14px;">Results for ' +
          escapeHtmlGas(p.firstName) + ' ' + escapeHtmlGas(p.lastName) +
          ' &mdash; Set ' + p.set + '</p>' +
      '</div>' +

      // Score strip
      '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F7FF;border:1px solid #BFDBFE;border-top:none;">' +
        '<tr>' +
          '<td align="center" style="padding:20px;">' +
            '<div style="font-size:48px;font-weight:bold;color:' + gradeColor + ';line-height:1;">' + escapeHtmlGas(p.finalGrade) + '</div>' +
            '<div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px;">Final Grade</div>' +
          '</td>' +
          '<td align="center" style="padding:20px;border-left:1px solid #BFDBFE;">' +
            '<div style="font-size:36px;font-weight:bold;color:#1F4E78;">' + p.percentage + '%</div>' +
            '<div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px;">Score</div>' +
          '</td>' +
          '<td align="center" style="padding:20px;border-left:1px solid #BFDBFE;">' +
            '<div style="font-size:28px;font-weight:bold;color:#1F4E78;">' + p.totalScore + '/' + p.maxScore + '</div>' +
            '<div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px;">Points</div>' +
          '</td>' +
        '</tr>' +
      '</table>';

    if (p.penalty > 0) {
      html += '<div style="background:#FEF2F2;border:1px solid #FCA5A5;border-top:none;padding:10px 20px;font-size:13px;color:#DC2626;">' +
        '&#9888; &minus;' + p.penalty + ' point anti-cheating penalty applied' +
      '</div>';
    }

    // Question breakdown
    html += '<div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 8px 8px;">';

    (p.mcFeedback || []).forEach(function(mc) {
      var bg     = mc.correct ? '#F0FDF4' : '#FEF2F2';
      var border = mc.correct ? '#86EFAC' : '#FCA5A5';
      var icon   = mc.correct ? '&#10003;' : '&#10007;';
      var iconColor = mc.correct ? '#16A34A' : '#DC2626';
      html += '<div style="border-top:1px solid #E2E8F0;padding:14px 20px;background:' + bg + ';">' +
        '<div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">' +
          'Multiple Choice &mdash; ' + mc.earned + '/' + mc.points + ' pts</div>' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">' + escapeHtmlGas(mc.questionText) + '</div>' +
        '<div style="font-size:13px;color:' + iconColor + ';font-weight:600;">' + icon + ' Your answer: ' + escapeHtmlGas(mc.selectedText) + '</div>';
      if (!mc.correct && mc.correctText) {
        html += '<div style="font-size:13px;color:#16A34A;margin-top:4px;">&#10003; Correct answer: <strong>' + escapeHtmlGas(mc.correctText) + '</strong></div>';
      }
      html += '</div>';
    });

    (p.openFeedback || []).forEach(function(oe) {
      html += '<div style="border-top:1px solid #E2E8F0;padding:14px 20px;">' +
        '<div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">' +
          'Open-Ended &mdash; ' + oe.score + '/' + oe.maxScore + ' pts</div>' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">' + escapeHtmlGas(oe.questionText) + '</div>';
      if (oe.studentAnswer) {
        html += '<div style="background:#F8FAFC;border-left:3px solid #94A3B8;padding:8px 12px;font-size:13px;color:#475569;margin-bottom:8px;">' +
          escapeHtmlGas(oe.studentAnswer) + '</div>';
      }
      html += '<div style="font-size:13px;color:#1F4E78;font-style:italic;">&#128172; ' + escapeHtmlGas(oe.feedback) + '</div>' +
      '</div>';
    });

    html += '</div>' +
      '<p style="font-size:12px;color:#94A3B8;text-align:center;margin-top:16px;">' +
        'You can view your results at any time on the Results page.</p>' +
    '</div>';

    MailApp.sendEmail({ to: p.email, subject: subject, htmlBody: html });

  } catch(e) {
    console.log('Results email failed: ' + e.message);
  }
}

// ============================================================
// QUESTION MANAGEMENT  (admin panel)
// ============================================================
function getAdminQuestionsResponse() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet = ss.getSheetByName(QUESTIONS_SHEET);
  if (!qSheet) {
    return ContentService
      .createTextOutput(safeJson({questions: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rows = qSheet.getDataRange().getValues();
  var questions = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    var id  = String(row[1]).trim();
    if (!id) { continue; }
    questions.push({
      rowIndex:     r + 1,
      set:          String(row[0]).trim(),
      id:           id,
      section:      String(row[2]).trim(),
      type:         String(row[3]).trim(),
      points:       Number(row[4]) || 1,
      text:         String(row[5]).trim(),
      optA:         String(row[6]).trim(),
      optB:         String(row[7]).trim(),
      optC:         String(row[8]).trim(),
      optD:         String(row[9]).trim(),
      correctIndex: (row[10] !== '' && row[10] !== null && row[10] !== undefined) ? Number(row[10]) : 0,
      rubric:       String(row[11]).trim(),
      exam:         String(row[12] !== undefined ? row[12] : '').trim(),
      image:        String(row[13] !== undefined ? row[13] : '').trim(),
      imageUrl:     driveImageUrl_(String(row[13] !== undefined ? row[13] : '').trim())
    });
  }
  return ContentService
    .createTextOutput(safeJson({questions: questions}))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleAddQuestion(data) {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet = ss.getSheetByName(QUESTIONS_SHEET);
  if (!qSheet) { qSheet = createQuestionsSheet(ss); }
  var q  = data.question || {};
  var id = String(q.set || 'A').toUpperCase() + '_' + Date.now();
  qSheet.appendRow([
    String(q.set || 'A').toUpperCase(),
    id,
    String(q.section || ''),
    String(q.type || 'mc'),
    Number(q.points) || 1,
    String(q.text || ''),
    String(q.optA || ''),
    String(q.optB || ''),
    String(q.optC || ''),
    String(q.optD || ''),
    q.type === 'mc' ? (Number(q.correctIndex) || 0) : '',
    String(q.rubric || ''),
    String(q.exam || ''),
    String(q.image || '')
  ]);
  return ContentService
    .createTextOutput(JSON.stringify({success: true, id: id}))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleUpdateQuestion(data) {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet = ss.getSheetByName(QUESTIONS_SHEET);
  if (!qSheet) { return ContentService.createTextOutput(JSON.stringify({success: false, error: 'No Questions sheet'})).setMimeType(ContentService.MimeType.JSON); }
  var q        = data.question || {};
  var targetId = String(q.id || '');
  var rows     = qSheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim() === targetId) {
      qSheet.getRange(i + 1, 1, 1, 14).setValues([[
        String(q.set || rows[i][0]).toUpperCase(),
        targetId,
        String(q.section !== undefined ? q.section : rows[i][2]),
        String(q.type || rows[i][3]),
        Number(q.points) || rows[i][4],
        String(q.text || rows[i][5]),
        String(q.optA !== undefined ? q.optA : rows[i][6]),
        String(q.optB !== undefined ? q.optB : rows[i][7]),
        String(q.optC !== undefined ? q.optC : rows[i][8]),
        String(q.optD !== undefined ? q.optD : rows[i][9]),
        (q.type || rows[i][3]) === 'mc' ? Number(q.correctIndex !== undefined ? q.correctIndex : rows[i][10]) : '',
        String(q.rubric !== undefined ? q.rubric : rows[i][11]),
        String(q.exam !== undefined ? q.exam : (rows[i][12] !== undefined ? rows[i][12] : '')),
        String(q.image !== undefined ? q.image : (rows[i][13] !== undefined ? rows[i][13] : ''))
      ]]);
      return ContentService
        .createTextOutput(JSON.stringify({success: true}))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService
    .createTextOutput(JSON.stringify({success: false, error: 'Question not found'}))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleDeleteQuestion(data) {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet = ss.getSheetByName(QUESTIONS_SHEET);
  if (!qSheet) { return ContentService.createTextOutput(JSON.stringify({success: false, error: 'No Questions sheet'})).setMimeType(ContentService.MimeType.JSON); }
  var targetId = String(data.questionId || '');
  var rows     = qSheet.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][1]).trim() === targetId) {
      qSheet.deleteRow(i + 1);
      return ContentService
        .createTextOutput(JSON.stringify({success: true}))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService
    .createTextOutput(JSON.stringify({success: false, error: 'Question not found'}))
    .setMimeType(ContentService.MimeType.JSON);
}

// RECALCULATION HELPER
// ============================================================
function recalcRow(row, boundaries) {
  var set      = String(row[COL.SET - 1]);
  var mcScore  = Number(row[COL.MC_SCORE - 1])  || 0;
  var penalty  = Number(row[COL.PENALTY - 1])   || 0;
  var maxScore = Number(row[COL.MAX_SCORE - 1]) || 60;

  var AI_COLS  = [COL.Q1_AI,  COL.Q2_AI,  COL.Q3_AI,  COL.Q4_AI,  COL.Q5_AI];
  var OVR_COLS = [COL.Q1_OVR, COL.Q2_OVR, COL.Q3_OVR, COL.Q4_OVR, COL.Q5_OVR];

  var openScore = 0;
  for (var qi = 0; qi < 5; qi++) {
    var ai  = row[AI_COLS[qi] - 1];
    var ovr = row[OVR_COLS[qi] - 1];
    if (ai !== '' && ai !== null && ai !== undefined) {
      var effective = (ovr !== '' && ovr !== null && ovr !== undefined) ? Number(ovr) : Number(ai);
      openScore += effective;
    }
  }

  var totalScore = Math.max(0, mcScore + openScore - penalty);
  var percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  var finalGrade = calculateGrade(percentage, set, boundaries);

  return {
    openScore:  openScore,
    totalScore: totalScore,
    percentage: percentage,
    finalGrade: finalGrade
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
    sheet.getRange(sheetRow, COL.TOTAL_SCORE).setValue(updated.totalScore);
    sheet.getRange(sheetRow, COL.PERCENTAGE).setValue(updated.percentage);
    sheet.getRange(sheetRow, COL.FINAL_GRADE).setValue(updated.finalGrade);
    changed++;
  }

  SpreadsheetApp.getUi().alert('Done. Recalculated ' + changed + ' submission(s).');
}

// ============================================================
// HANDLE BULK RECALCULATE  (from admin.html)
// ============================================================
function handleBulkRecalc() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'No Submissions sheet found.'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data    = sheet.getDataRange().getValues();
  var changed = 0;
  var effectiveBoundaries = loadEffectiveBoundaries();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[COL.Q1_AI - 1] === '' || row[COL.Q1_AI - 1] === null || row[COL.Q1_AI - 1] === undefined) { continue; }

    var updated  = recalcRow(row, effectiveBoundaries);
    var sheetRow = i + 1;
    sheet.getRange(sheetRow, COL.OPEN_SCORE).setValue(updated.openScore);
    sheet.getRange(sheetRow, COL.TOTAL_SCORE).setValue(updated.totalScore);
    sheet.getRange(sheetRow, COL.PERCENTAGE).setValue(updated.percentage);
    sheet.getRange(sheetRow, COL.FINAL_GRADE).setValue(updated.finalGrade);
    changed++;
  }

  return ContentService
    .createTextOutput(JSON.stringify({success: true, changed: changed}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// RESEND RESULTS EMAILS  (from admin.html)
// ============================================================
function handleResendEmails(data) {
  var examId   = String(data.examId   || '').trim();
  var cls      = String(data.cls      || '').trim();
  var set      = String(data.set      || '').trim();
  var dateFrom = String(data.dateFrom || '').trim();
  var dateTo   = String(data.dateTo   || '').trim();

  var fromTs = dateFrom ? new Date(dateFrom).getTime()             : 0;
  var toTs   = dateTo   ? new Date(dateTo + 'T23:59:59').getTime() : Infinity;

  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var subSheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  var detSheet = ss.getSheetByName(DETAILS_SHEET);

  if (!subSheet) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'No Submissions sheet.'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Build Detailed_Answers lookup keyed by timestamp
  var detByTs = {};
  if (detSheet && detSheet.getLastRow() > 1) {
    var detData = detSheet.getDataRange().getValues();
    for (var di = 1; di < detData.length; di++) {
      var dr   = detData[di];
      var ts   = String(dr[DCOL.TIMESTAMP]);
      var type = String(dr[DCOL.TYPE]).trim();
      if (!detByTs[ts]) { detByTs[ts] = {mc: [], oe: []}; }
      if (type === 'mc') {
        detByTs[ts].mc.push({
          correct:      String(dr[DCOL.IS_CORRECT]).toUpperCase() === 'TRUE',
          earned:       Number(dr[DCOL.AI_SCORE])  || 0,
          points:       Number(dr[DCOL.MAX_SCORE])  || 0,
          questionText: String(dr[DCOL.QUESTION_TEXT]),
          selectedText: String(dr[DCOL.STUDENT_ANSWER]),
          correctText:  String(dr[DCOL.CORRECT_ANSWER])
        });
      } else if (type === 'openEnded') {
        detByTs[ts].oe.push({
          score:         Number(dr[DCOL.AI_SCORE])  || 0,
          maxScore:      Number(dr[DCOL.MAX_SCORE])  || 0,
          questionText:  String(dr[DCOL.QUESTION_TEXT]),
          studentAnswer: String(dr[DCOL.STUDENT_ANSWER]),
          feedback:      String(dr[DCOL.AI_FEEDBACK])
        });
      }
    }
  }

  // Filter submissions and resend
  var subData = subSheet.getDataRange().getValues();
  var sent = 0;
  var errors = 0;

  for (var si = 1; si < subData.length; si++) {
    var row      = subData[si];
    var rowTs    = String(row[COL.TIMESTAMP  - 1]);
    var rowEmail = String(row[COL.EMAIL      - 1]).trim();
    var rowCls   = String(row[COL.CLASS      - 1]).trim();
    var rowSet   = String(row[COL.SET        - 1]).trim();
    var rowExam  = String(row[COL.EXAM_ID    - 1] || '').trim();

    if (!rowEmail) { continue; }
    if (examId && rowExam !== examId) { continue; }
    if (cls    && rowCls  !== cls)    { continue; }
    if (set    && rowSet  !== set)    { continue; }
    if (fromTs || toTs < Infinity) {
      var rowTime = new Date(rowTs).getTime();
      if (rowTime < fromTs || rowTime > toTs) { continue; }
    }

    var det = detByTs[rowTs] || {mc: [], oe: []};
    try {
      sendResultsEmail({
        email:        rowEmail,
        firstName:    String(row[COL.FIRST_NAME  - 1]),
        lastName:     String(row[COL.LAST_NAME   - 1]),
        set:          rowSet,
        finalGrade:   String(row[COL.FINAL_GRADE - 1]),
        percentage:   Number(row[COL.PERCENTAGE  - 1]) || 0,
        totalScore:   Number(row[COL.TOTAL_SCORE - 1]) || 0,
        maxScore:     Number(row[COL.MAX_SCORE   - 1]) || 0,
        penalty:      Number(row[COL.PENALTY     - 1]) || 0,
        mcFeedback:   det.mc,
        openFeedback: det.oe
      });
      sent++;
    } catch(e) {
      errors++;
      console.log('Resend failed for ' + rowEmail + ': ' + e.message);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({success: true, sent: sent, errors: errors}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// REGRADE ALL MC (from admin.html)
// ============================================================
function handleRegradeAllMC() {
  var ss          = SpreadsheetApp.getActiveSpreadsheet();
  var detailSheet = ss.getSheetByName(DETAILS_SHEET);
  var submSheet   = ss.getSheetByName(SUBMISSIONS_SHEET);
  var qSheet      = ss.getSheetByName(QUESTIONS_SHEET);

  if (!detailSheet || !submSheet || !qSheet) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Required sheet not found.'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Build correct-answer map from Questions sheet
  var questionMap = {};
  var qData = qSheet.getDataRange().getValues();
  for (var qi = 1; qi < qData.length; qi++) {
    var qr = qData[qi];
    if (String(qr[3]).trim() !== 'mc') { continue; }
    var qid = String(qr[1]).trim();
    if (!qid) { continue; }
    var opts = [String(qr[6]).trim(), String(qr[7]).trim(), String(qr[8]).trim(), String(qr[9]).trim()];
    var cidx = Number(qr[10]) - 1;
    questionMap[qid] = {correctText: opts[cidx], points: Number(qr[4])};
  }

  // Re-grade MC rows in Detailed_Answers; tally new MC score per submission timestamp
  var detailData  = detailSheet.getDataRange().getValues();
  var mcScoreByTs = {};

  for (var di = 1; di < detailData.length; di++) {
    var dr = detailData[di];
    if (String(dr[DCOL.TYPE]).trim() !== 'mc') { continue; }

    var qid   = String(dr[DCOL.QUESTION_ID]).trim();
    var qInfo = questionMap[qid];
    if (!qInfo) { continue; }

    var selectedText = String(dr[DCOL.STUDENT_ANSWER]).trim();
    var correctText  = qInfo.correctText;
    var maxPts       = qInfo.points;
    var correct      = selectedText !== 'No answer' && selectedText === correctText;
    var earned       = correct ? maxPts : 0;
    var feedback     = correct ? 'Correct' : ('Incorrect. Correct answer: ' + correctText);

    detailSheet.getRange(di + 1, DCOL.CORRECT_ANSWER + 1, 1, 5).setValues([[
      correctText, correct ? 'TRUE' : 'FALSE', earned, maxPts, feedback
    ]]);

    var ts = String(dr[DCOL.TIMESTAMP]);
    if (!mcScoreByTs[ts]) { mcScoreByTs[ts] = 0; }
    mcScoreByTs[ts] += earned;
  }

  // Update Submissions: new MC_SCORE then recalculate totals
  var submData = submSheet.getDataRange().getValues();
  var effectiveBoundaries = loadEffectiveBoundaries();
  var changed = 0;

  for (var si = 1; si < submData.length; si++) {
    var row = submData[si];
    var ts  = String(row[COL.TIMESTAMP - 1]);
    if (!(ts in mcScoreByTs)) { continue; }

    var newMcScore       = mcScoreByTs[ts];
    row[COL.MC_SCORE - 1] = newMcScore;
    var updated  = recalcRow(row, effectiveBoundaries);
    var sheetRow = si + 1;

    submSheet.getRange(sheetRow, COL.MC_SCORE).setValue(newMcScore);
    submSheet.getRange(sheetRow, COL.TOTAL_SCORE).setValue(updated.totalScore);
    submSheet.getRange(sheetRow, COL.PERCENTAGE).setValue(updated.percentage);
    submSheet.getRange(sheetRow, COL.FINAL_GRADE).setValue(updated.finalGrade);
    changed++;
  }

  return ContentService
    .createTextOutput(JSON.stringify({success: true, changed: changed}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// MC DISTRACTOR ANALYSIS
// ============================================================
function handleMcDistractors() {
  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet   = ss.getSheetByName(QUESTIONS_SHEET);
  var detSheet = ss.getSheetByName(DETAILS_SHEET);

  if (!qSheet) {
    return ContentService
      .createTextOutput(safeJson({success: true, questions: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Build question lookup preserving sheet order
  var qData  = qSheet.getDataRange().getValues();
  var qMap   = {};
  var qOrder = [];
  for (var i = 1; i < qData.length; i++) {
    var row   = qData[i];
    var qtype = String(row[3]).trim();
    var id    = String(row[1]).trim();
    if (!id || qtype !== 'mc') { continue; }
    var opts = [
      String(row[6]).trim(), String(row[7]).trim(),
      String(row[8]).trim(), String(row[9]).trim()
    ];
    var cidx = Number(row[10]) - 1;  // 1-based in sheet, 0-based in array
    qMap[id] = {
      set:         String(row[0]).trim(),
      text:        String(row[5]).trim(),
      options:     opts,
      correctText: opts[cidx] || '',
      exam:        String(row[12] !== undefined ? row[12] : '').trim()
    };
    qOrder.push(id);
  }

  // Tally student answers from Detailed_Answers
  var tallies = {};
  var totals  = {};
  if (detSheet && detSheet.getLastRow() > 1) {
    var detData = detSheet.getDataRange().getValues();
    for (var d = 1; d < detData.length; d++) {
      var dr = detData[d];
      if (String(dr[DCOL.TYPE]) !== 'mc') { continue; }
      var qid = String(dr[DCOL.QUESTION_ID]);
      if (!qMap[qid]) { continue; }
      var ans = String(dr[DCOL.STUDENT_ANSWER]);
      if (!tallies[qid]) { tallies[qid] = {}; totals[qid] = 0; }
      tallies[qid][ans] = (tallies[qid][ans] || 0) + 1;
      totals[qid]++;
    }
  }

  // Build result in sheet order
  var result = [];
  for (var qi = 0; qi < qOrder.length; qi++) {
    var qid   = qOrder[qi];
    var q     = qMap[qid];
    var tally = tallies[qid] || {};
    var total = totals[qid]  || 0;
    var optionCounts = [];
    for (var oi = 0; oi < q.options.length; oi++) {
      var optText = q.options[oi];
      optionCounts.push({
        text:    optText,
        count:   tally[optText] || 0,
        correct: optText === q.correctText
      });
    }
    result.push({
      questionId:   qid,
      set:          q.set,
      exam:         q.exam,
      questionText: q.text,
      options:      optionCounts,
      total:        total,
      noAnswer:     tally['No answer'] || 0
    });
  }

  return ContentService
    .createTextOutput(safeJson({success: true, questions: result}))
    .setMimeType(ContentService.MimeType.JSON);
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

  var AI_COLS = [COL.Q1_AI, COL.Q2_AI, COL.Q3_AI, COL.Q4_AI, COL.Q5_AI];

  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var q1ai = row[COL.Q1_AI - 1];
    if (q1ai !== '' && q1ai !== null && q1ai !== undefined) { continue; }

    var openFb = String(row[COL.OPEN_FB - 1] || '');
    if (!openFb) { continue; }

    var sheetRow = i + 1;
    var qIdx = 0;
    var match;

    regex.lastIndex = 0;
    while ((match = regex.exec(openFb)) !== null) {
      if (qIdx < 5) {
        sheet.getRange(sheetRow, AI_COLS[qIdx]).setValue(parseInt(match[2]));
        qIdx++;
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
  sheet.appendRow(['exam_id',               'exam_1']);
  sheet.appendRow(['exam_title',            'Exam']);
  sheet.appendRow(['exam_subtitle',         'Select your question set to begin.']);
  sheet.appendRow(['class_options',         '10A,10B,10C']);
  sheet.appendRow(['exam_duration_minutes', '60']);
  sheet.appendRow(['exam_active',           'true']);
  sheet.appendRow(['admin_password',        '']);
  sheet.appendRow(['randomize_questions',   'false']);
  sheet.appendRow(['questions_per_set',     '0']);
  sheet.appendRow(['oe_per_set',            '0']);
  sheet.appendRow(['set_mode',              'triple']);
  sheet.appendRow(['grade_boundaries_A',    '2.3:85,2.0:70,1.7:50,1.3:35,1.0:0']);
  sheet.appendRow(['grade_boundaries_B',    '3.3:85,3.0:75,2.7:65,2.3:55,2.0:45,1.7:35,1.3:20,1.0:0']);
  sheet.appendRow(['grade_boundaries_C',    '4.0:90,3.7:80,3.3:70,3.0:60,2.7:50,2.3:40,2.0:30,1.7:20,1.3:10,1.0:0']);
  sheet.appendRow(['set_a_label',           'SET A — Standard']);
  sheet.appendRow(['set_a_max_grade',       '2.3']);
  sheet.appendRow(['set_a_description',     'Foundational questions.']);
  sheet.appendRow(['set_b_label',           'SET B — Intermediate']);
  sheet.appendRow(['set_b_max_grade',       '3.3']);
  sheet.appendRow(['set_b_description',     'Application & calculation.']);
  sheet.appendRow(['set_c_label',           'SET C — Advanced']);
  sheet.appendRow(['set_c_max_grade',       '4.0']);
  sheet.appendRow(['set_c_description',     'Complex system analysis.']);
  return sheet;
}

// ============================================================
// IMAGE UPLOAD  (stored in the teacher's own Google Drive)
// ============================================================
function handleUploadImage(data) {
  try {
    var b64  = String(data.dataBase64 || '');
    var mime = String(data.mimeType || 'image/png');
    var name = String(data.filename || ('question_image_' + Date.now()));
    if (!b64) {
      return ContentService.createTextOutput(JSON.stringify({success: false, error: 'No image data received.'})).setMimeType(ContentService.MimeType.JSON);
    }
    var bytes = Utilities.base64Decode(b64);
    var blob  = Utilities.newBlob(bytes, mime, name);
    var file  = getImageFolder_().createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var id = file.getId();
    return ContentService
      .createTextOutput(JSON.stringify({success: true, fileId: id, imageUrl: driveImageUrl_(id)}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Get (or create) the per-teacher Drive folder that holds question images.
function getImageFolder_() {
  var name = 'Exam Grader Images';
  var it   = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

// Build an <img>-embeddable URL from a Drive file id. Empty id -> ''.
function driveImageUrl_(id) {
  if (!id) { return ''; }
  return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600';
}

// PHASE 3 SETUP — run once from the editor to grant Drive access and create
// the image folder. Approve the Drive permission when prompted. Safe to delete later.
function testImageSetup() {
  var folder = getImageFolder_();
  Logger.log('Image folder ready: ' + folder.getName() + ' (id ' + folder.getId() + ')');
  return folder.getId();
}

function createQuestionsSheet(ss) {
  if (!ss) { ss = SpreadsheetApp.getActiveSpreadsheet(); }
  var sheet = ss.insertSheet(QUESTIONS_SHEET);
  sheet.appendRow(['Set','ID','Section','Type','Points','Text','Option_A','Option_B','Option_C','Option_D','CorrectIndex','Rubric','Exam','Image']);
  return sheet;
}
