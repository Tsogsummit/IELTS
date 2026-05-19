import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const STUDENT_CSV = "/Users/tsogboldbaatar/Desktop/final_exam/exports/student_credentials.csv";
const PORT = process.env.PORT || 3002;
const COOKIE = "bandprep_session";
const EXAM_DATE = process.env.EXAM_DATE || "2026-05-19";
const EXAM_TZ_OFFSET = process.env.EXAM_TZ_OFFSET || "+08:00";
const sessions = new Map();
const loginHits = new Map();

const disclaimer = "This website is an independent IELTS practice platform. It is not affiliated with IELTS, British Council, IDP, or Cambridge.";

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, stored] = String(passwordHash || "").split(":");
  if (!salt || !stored) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(stored, "hex"));
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers, ...data] = rows;
  return data.map((cells) => Object.fromEntries(headers.map((h, i) => [h.trim(), (cells[i] || "").trim()])));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","))].join("\n");
}

function normalizeName(text) {
  return String(text || "student")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "student";
}

function generatePassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const nums = "23456789";
  const all = upper + lower + nums;
  let pass = upper[Math.floor(Math.random() * upper.length)] + lower[Math.floor(Math.random() * lower.length)] + nums[Math.floor(Math.random() * nums.length)];
  while (pass.length < 9) pass += all[Math.floor(Math.random() * all.length)];
  return pass.split("").sort(() => Math.random() - 0.5).join("");
}

function generateUsername(name, className, existing) {
  let base = `${normalizeName(name)}_${normalizeName(className)}`;
  for (let i = 0; i < 50; i++) {
    const candidate = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

function bandFromRaw(score) {
  if (score >= 39) return 9;
  if (score >= 37) return 8.5;
  if (score >= 35) return 8;
  if (score >= 32) return 7.5;
  if (score >= 30) return 7;
  if (score >= 26) return 6.5;
  if (score >= 23) return 6;
  if (score >= 18) return 5.5;
  if (score >= 16) return 5;
  if (score >= 13) return 4.5;
  if (score >= 10) return 4;
  return Math.max(0, Math.round((score / 40) * 4 * 2) / 2);
}

function scheduleWindow(startTime, endTime) {
  return {
    startsAt: `${EXAM_DATE}T${startTime}:00${EXAM_TZ_OFFSET}`,
    endsAt: `${EXAM_DATE}T${endTime}:00${EXAM_TZ_OFFSET}`
  };
}

function scheduledStatus(test) {
  if (!test.startsAt || !test.endsAt) return { scheduled: false, available: true };
  const current = Date.now();
  const start = new Date(test.startsAt).getTime();
  const end = new Date(test.endsAt).getTime();
  return {
    scheduled: true,
    available: current >= start && current < end,
    notStarted: current < start,
    ended: current >= end,
    secondsUntilStart: Math.max(0, Math.ceil((start - current) / 1000)),
    secondsUntilEnd: Math.max(0, Math.ceil((end - current) / 1000))
  };
}

function canBypassSchedule(user) {
  return ["super_admin", "admin"].includes(user.role) || String(user.className || "").toUpperCase() === "TEST";
}

function roundIeltsAverage(scores) {
  const avg = scores.reduce((a, b) => a + Number(b || 0), 0) / 4;
  const whole = Math.floor(avg);
  const dec = avg - whole;
  if (dec < 0.25) return whole;
  if (dec < 0.75) return whole + 0.5;
  return whole + 1;
}

function sampleTests() {
  const listeningId = "test_listening_1";
  const readingId = "test_reading_1";
  const writingId = "test_writing_1";
  const speakingId = "test_speaking_1";
  return [
    {
      id: listeningId,
      title: "IELTS Listening Mock 1",
      type: "listening",
      duration: 40,
      ...scheduleWindow("14:10", "14:50"),
      audioUrl: "",
      createdAt: now(),
      sections: [
        { title: "Part 1: Furniture Rental Companies", instructions: "Complete the notes. Write ONE WORD AND/OR A NUMBER for each answer." },
        { title: "Part 2: Bidcaster Community Archaeology Project", instructions: "Choose the correct letter, A, B, or C. Use the Bidcaster Archaeological Dig map for the map-label questions.", image: "/assets/bidcaster-archaeological-dig.svg" },
        { title: "Part 3: Project on Theatre Programmes", instructions: "Choose the correct letter, A, B, or C." },
        { title: "Part 4: Inclusive Design", instructions: "Complete the notes. Write ONE WORD ONLY for each answer." }
      ],
      questions: [
        q(listeningId, 1, 1, "Prices range from $105 to ____ per month.", "blank", [], "240", "The note asks for the maximum monthly rental price."),
        q(listeningId, 1, 2, "The furniture is very ____.", "blank", [], "modern", "The adjective describes the furniture quality."),
        q(listeningId, 1, 3, "Free ____ with every living room set.", "blank", [], "delivery", "The special offer concerns delivery."),
        q(listeningId, 1, 4, "Company name: ____ and Oliver.", "blank", [], "Smith", "The company name completes the note."),
        q(listeningId, 1, 5, "12% monthly fee for ____.", "blank", [], "insurance", "The monthly fee is for insurance."),
        q(listeningId, 1, 6, "Cheapest prices for renting furniture and ____ items.", "blank", [], "electrical", "The category is electrical items."),
        q(listeningId, 1, 7, "Must have own ____.", "blank", [], "transport", "Customers need transport."),
        q(listeningId, 1, 8, "____ Rentals.", "blank", [], "City", "The company name is City Rentals."),
        q(listeningId, 1, 9, "See the ____ for the most up-to-date prices.", "blank", [], "website", "Prices are updated online."),
        q(listeningId, 1, 10, "____ are allowed within 7 days of delivery.", "blank", [], "exchanges", "The policy allows exchanges.")
      ]
    },
    {
      id: readingId,
      title: "IELTS Reading Mock 1",
      type: "reading",
      duration: 60,
      ...scheduleWindow("15:00", "16:00"),
      passageTitle: "Frozen Food",
      passage: `A US perspective on the development of the frozen food industry.\n\nAt some point in history, humans discovered that ice preserved food. Two thousand years ago, the inhabitants of South America's Andean mountains conserved potatoes by freezing them overnight, trampling them to squeeze out moisture, then drying them in the sun.\n\nNatural ice remained the main form of refrigeration until late in the 19th century. In 1851, railroads began putting blocks of ice in insulated rail cars to send butter from Ogdensburg, New York, to Boston.\n\nIn 1870, Australian inventors found a way to make mechanical ice. Cattlemen realized this invention could export meat across oceans. In 1880, Australian beef and mutton was sent frozen to England, although crystals could spoil flavor and texture.\n\nThe modern frozen food industry began after Clarence Birdseye observed Inuit quick-freezing fish in Arctic air. Birdseye later developed mechanical freezers, quick-freezing techniques, packaging products in cellophane, and convenient consumer-sized packs.\n\nSales increased in the early 1940s when World War II made tin scarce for canned food. By the 1950s, refrigerator technology had become affordable, and millions of US families owned refrigerators. Swanson launched the TV Dinner in 1954 with a clever name and huge advertising budget.`,
      createdAt: now(),
      questions: [
        q(readingId, 1, 1, "People conserved the nutritional value of ____ using freezing and drying.", "blank", [], "potatoes", "The Andean method preserved potatoes."),
        q(readingId, 1, 2, "____ was kept cool by ice in specially adapted trains.", "blank", [], "butter", "The passage names butter sent by rail."),
        q(readingId, 1, 3, "Two kinds of ____ were first shipped frozen to England.", "blank", [], "meat", "Beef and mutton are both meat."),
        q(readingId, 1, 4, "Quick freezing reduced damage caused by ____.", "blank", [], "crystals", "Crystals caused flavor and texture damage."),
        q(readingId, 1, 5, "Cellophane let customers see the ____.", "blank", [], "quality", "Transparent packaging showed quality."),
        q(readingId, 1, 6, "Frozen food became popular because of a shortage of ____.", "blank", [], "tin", "Tin was reserved for wartime munitions."),
        q(readingId, 1, 7, "By the 1950s many homes had a ____.", "blank", [], "refrigerator", "The passage describes affordable refrigerators."),
        q(readingId, 1, 8, "Australian freezing affected the taste of food.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "TRUE", "The passage says flavor and texture deteriorated."),
        q(readingId, 1, 9, "Birdseye went to Labrador specifically to learn freezing techniques.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "FALSE", "He went there to trap and trade furs."),
        q(readingId, 1, 10, "Swanson spent heavily to promote the TV Dinner.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "TRUE", "The passage mentions a huge advertising budget.")
      ]
    },
    {
      id: writingId,
      title: "IELTS Writing Mock 1",
      type: "writing",
      duration: 60,
      ...scheduleWindow("16:10", "17:10"),
      task1: "The line graph shows the percentage of people who used five different communication methods between 1998 and 2008. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.",
      task1Image: "/assets/writing-task-communication-graph.svg",
      task2: "Many manufactured food and drink products contain high levels of sugar, which causes many health problems. Sugary products should be made more expensive to encourage people to consume less sugar. To what extent do you agree or disagree?",
      createdAt: now(),
      questions: []
    },
    {
      id: speakingId,
      title: "IELTS Speaking Practice 1",
      type: "speaking",
      duration: 15,
      parts: [
        { title: "Part 1: Interview", questions: ["Do you work or study?", "What subject do you enjoy most?", "How do you usually prepare for exams?"] },
        { title: "Part 2: Cue Card", cue: "Describe a useful skill you learned. You should say what it is, when you learned it, how you learned it, and explain why it is useful." },
        { title: "Part 3: Discussion", questions: ["Which skills are most important for young people?", "How has technology changed learning?", "Should schools teach more practical skills?"] }
      ],
      createdAt: now(),
      questions: []
    }
  ];
}

function q(testId, section, number, questionText, questionType, options, correctAnswer, explanation) {
  return { id: `${testId}_q${number}`, testId, section, number, questionText, questionType, options, correctAnswer, explanation };
}

function seedDb() {
  const users = [
    staff("Super Admin", "superadmin", "SuperAdmin123", "super_admin"),
    staff("Academic Admin", "admin", "Admin1234", "admin"),
    staff("Default Grader", "grader", "Grader1234", "grader")
  ];
  const classes = new Set();
  if (fs.existsSync(STUDENT_CSV)) {
    parseCsv(fs.readFileSync(STUDENT_CSV, "utf8"))
      .filter((row) => /^11/i.test(row.class || ""))
      .forEach((row) => {
        const name = `${row.family_name || ""} ${row.given_name || ""}`.trim();
        classes.add(row.class);
        users.push({
          id: id("usr"),
          name,
          username: row.username,
          email: "",
          passwordHash: hashPassword(row.password),
          temporaryPassword: null,
          mustChangePassword: false,
          role: "student",
          className: row.class,
          phone: "",
          parentName: "",
          isActive: true,
          createdAt: now(),
          updatedAt: now()
        });
      });
  }
  return {
    meta: { createdAt: now(), disclaimer, seededFrom: STUDENT_CSV, importedGrade: "11" },
    users,
    studentClasses: [...classes].sort().map((className) => ({ id: id("class"), className, description: "Grade 11 IELTS mock cohort", createdAt: now() })),
    tests: sampleTests(),
    submissions: [],
    graderAssignments: [],
    writingGrades: [],
    speakingGrades: [],
    credentialBatches: []
  };
}

function staff(name, username, password, role) {
  return { id: id("usr"), name, username, email: "", passwordHash: hashPassword(password), temporaryPassword: null, mustChangePassword: false, role, className: "", isActive: true, createdAt: now(), updatedAt: now() };
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDb(seedDb());
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, { "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", ...headers });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function getCookie(req, name) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((p) => p.trim().split("=")))[name];
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

function currentUser(req, db) {
  const token = getCookie(req, COOKIE);
  const userId = sessions.get(token);
  return db.users.find((u) => u.id === userId && u.isActive);
}

function requireRole(req, res, db, roles) {
  const user = currentUser(req, db);
  if (!user) {
    send(res, 401, { error: "Authentication required" });
    return null;
  }
  if (!roles.includes(user.role)) {
    send(res, 403, { error: "Access denied" });
    return null;
  }
  return user;
}

function scoreAnswers(test, answers) {
  let score = 0;
  const details = test.questions.map((question) => {
    const answer = String(answers[question.id] || "").trim();
    const expected = String(question.correctAnswer || "").trim();
    const correct = answer.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0;
    if (correct) score++;
    return { questionId: question.id, number: question.number, answer, correctAnswer: expected, correct, explanation: question.explanation, questionText: question.questionText };
  });
  return { score, estimatedBand: bandFromRaw(score), details };
}

async function api(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const ip = req.socket.remoteAddress || "local";
    const hits = loginHits.get(ip) || [];
    const recent = hits.filter((t) => Date.now() - t < 15 * 60 * 1000);
    if (recent.length > 20) return send(res, 429, { error: "Too many login attempts. Try again later." });
    const body = await parseBody(req);
    const user = db.users.find((u) => u.username === body.username && u.isActive);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      recent.push(Date.now());
      loginHits.set(ip, recent);
      return send(res, 401, { error: "Invalid username or password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, user.id);
    return send(res, 200, { user: publicUser(user) }, { "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` });
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    sessions.delete(getCookie(req, COOKIE));
    return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0` });
  }

  if (method === "GET" && url.pathname === "/api/me") {
    const user = currentUser(req, db);
    return send(res, 200, { user: user ? publicUser(user) : null });
  }

  if (method === "POST" && url.pathname === "/api/change-password") {
    return send(res, 403, { error: "Students cannot change passwords. Please contact an admin." });
  }

  if (method === "GET" && url.pathname === "/api/tests") {
    const user = requireRole(req, res, db, ["super_admin", "admin", "grader", "student"]);
    if (!user) return;
    return send(res, 200, { tests: db.tests.map(({ questions, ...test }) => ({ ...test, questionCount: questions.length, scheduleStatus: scheduledStatus(test) })) });
  }

  if (method === "GET" && url.pathname.startsWith("/api/tests/")) {
    const user = requireRole(req, res, db, ["super_admin", "admin", "student"]);
    if (!user) return;
    const test = db.tests.find((t) => t.id === url.pathname.split("/").pop());
    if (!test) return send(res, 404, { error: "Test not found" });
    const status = scheduledStatus(test);
    if (user.role === "student" && !canBypassSchedule(user) && status.scheduled && !status.available) {
      return send(res, 403, { error: status.notStarted ? "This test has not started yet" : "This test has ended", scheduleStatus: status });
    }
    const sanitized = { ...test, questions: test.questions.map(({ correctAnswer, explanation, ...safe }) => safe) };
    return send(res, 200, { test: sanitized });
  }

  if (method === "POST" && url.pathname === "/api/submissions") {
    const user = requireRole(req, res, db, ["student", "super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const test = db.tests.find((t) => t.id === body.testId);
    if (!test) return send(res, 404, { error: "Test not found" });
    const status = scheduledStatus(test);
    if (user.role === "student" && !canBypassSchedule(user) && status.scheduled && status.notStarted) return send(res, 403, { error: "This test has not started yet" });
    const base = { id: id("sub"), userId: user.id, testId: test.id, type: test.type, answers: body.answers || {}, timeSpent: body.timeSpent || 0, submittedAt: now(), status: "Pending Review" };
    if (["listening", "reading"].includes(test.type)) {
      const result = scoreAnswers(test, body.answers || {});
      Object.assign(base, { score: result.score, estimatedBand: result.estimatedBand, details: result.details, status: "Returned to Student" });
    } else {
      Object.assign(base, { score: null, estimatedBand: null, task1Answer: body.task1Answer, task2Answer: body.task2Answer, audioUrl: body.audioUrl });
    }
    db.submissions.push(base);
    writeDb(db);
    return send(res, 201, { submission: base });
  }

  if (method === "GET" && url.pathname === "/api/results") {
    const user = requireRole(req, res, db, ["super_admin", "admin", "grader", "student"]);
    if (!user) return;
    let submissions = db.submissions;
    if (user.role === "student") submissions = submissions.filter((s) => s.userId === user.id);
    if (user.role === "grader") {
      const assigned = new Set(db.graderAssignments.filter((a) => a.graderId === user.id).map((a) => a.submissionId));
      submissions = submissions.filter((s) => ["listening", "reading"].includes(s.type) || assigned.has(s.id));
    }
    return send(res, 200, { submissions: submissions.map((s) => ({ ...s, student: publicUser(db.users.find((u) => u.id === s.userId) || {}) })) });
  }

  if (method === "GET" && url.pathname.startsWith("/api/results/")) {
    const user = requireRole(req, res, db, ["super_admin", "admin", "grader", "student"]);
    if (!user) return;
    const submission = db.submissions.find((s) => s.id === url.pathname.split("/").pop());
    if (!submission) return send(res, 404, { error: "Result not found" });
    const assigned = db.graderAssignments.some((a) => a.submissionId === submission.id && a.graderId === user.id);
    if (user.role === "student" && submission.userId !== user.id) return send(res, 403, { error: "Access denied" });
    if (user.role === "grader" && !assigned && !["listening", "reading"].includes(submission.type)) return send(res, 403, { error: "Access denied" });
    return send(res, 200, { submission, test: db.tests.find((t) => t.id === submission.testId), grades: gradesFor(db, submission.id) });
  }

  if (method === "GET" && url.pathname === "/api/admin/users") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    return send(res, 200, { users: db.users.map(publicUser) });
  }

  if (method === "POST" && url.pathname === "/api/admin/tests") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    if (!body.title || !body.type || !body.duration) return send(res, 400, { error: "Title, type, and duration are required" });
    const test = {
      id: id("test"),
      title: String(body.title).trim(),
      type: body.type,
      duration: Number(body.duration),
      audioUrl: body.audioUrl || "",
      passageTitle: body.passageTitle || "",
      passage: body.passage || "",
      task1: body.task1 || "",
      task1Image: body.task1Image || "",
      task2: body.task2 || "",
      sections: body.sections || [],
      questions: [],
      createdAt: now()
    };
    db.tests.push(test);
    writeDb(db);
    return send(res, 201, { test });
  }

  if (method === "POST" && url.pathname === "/api/admin/questions") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const test = db.tests.find((t) => t.id === body.testId);
    if (!test) return send(res, 404, { error: "Test not found" });
    if (!["listening", "reading"].includes(test.type)) return send(res, 400, { error: "Questions can be added to Listening and Reading tests" });
    const number = Number(body.number || test.questions.length + 1);
    const question = {
      id: id("q"),
      testId: test.id,
      section: Number(body.section || 1),
      number,
      questionText: String(body.questionText || "").trim(),
      questionType: body.questionType || "blank",
      options: Array.isArray(body.options) ? body.options : String(body.options || "").split("\n").map((x) => x.trim()).filter(Boolean),
      correctAnswer: String(body.correctAnswer || "").trim(),
      explanation: String(body.explanation || "").trim()
    };
    if (!question.questionText || !question.correctAnswer) return send(res, 400, { error: "Question text and correct answer are required" });
    test.questions.push(question);
    test.questions.sort((a, b) => a.number - b.number);
    writeDb(db);
    return send(res, 201, { question });
  }

  if (method === "POST" && url.pathname === "/api/admin/users") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    if (user.role === "admin" && ["super_admin", "admin", "grader"].includes(body.role)) return send(res, 403, { error: "Admins can only create students here" });
    const existing = new Set(db.users.map((u) => u.username));
    const password = body.password || generatePassword();
    const created = {
      id: id("usr"),
      name: body.name,
      username: body.username || generateUsername(body.name, body.className || "", existing),
      email: body.email || "",
      passwordHash: hashPassword(password),
      temporaryPassword: null,
      mustChangePassword: false,
      role: body.role || "student",
      className: body.className || "",
      phone: body.phone || "",
      parentName: body.parentName || "",
      isActive: true,
      createdAt: now(),
      updatedAt: now()
    };
    db.users.push(created);
    writeDb(db);
    return send(res, 201, { user: publicUser(created), temporaryPassword: password });
  }

  if (method === "POST" && url.pathname.match(/^\/api\/admin\/users\/[^/]+\/reset-password$/)) {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const target = db.users.find((u) => u.id === url.pathname.split("/")[4]);
    if (!target) return send(res, 404, { error: "User not found" });
    if (user.role === "admin" && target.role !== "student") return send(res, 403, { error: "Admins can reset student passwords only" });
    const password = generatePassword();
    target.passwordHash = hashPassword(password);
    target.temporaryPassword = null;
    target.mustChangePassword = false;
    target.updatedAt = now();
    writeDb(db);
    return send(res, 200, { user: publicUser(target), temporaryPassword: password });
  }

  if (method === "POST" && url.pathname === "/api/admin/import-students") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const rows = parseCsv(body.csv || "").map((r) => ({ name: r.name || r.studentName, className: r.class || r.className, email: r.email || "", phone: r.phone || "", parentName: r.parentName || "" })).filter((r) => r.name && r.className);
    const existing = new Set(db.users.map((u) => u.username));
    const generated = rows.map((row) => {
      const username = generateUsername(row.name, row.className, existing);
      existing.add(username);
      return { ...row, username, temporaryPassword: generatePassword(), role: "student", createdAt: now(), duplicateName: db.users.some((u) => u.name === row.name && u.className === row.className) };
    });
    if (body.commit) {
      generated.forEach((row) => db.users.push({ id: id("usr"), name: row.name, username: row.username, email: row.email, passwordHash: hashPassword(row.temporaryPassword), temporaryPassword: null, mustChangePassword: false, role: "student", className: row.className, phone: row.phone, parentName: row.parentName, isActive: true, createdAt: row.createdAt, updatedAt: row.createdAt }));
      db.credentialBatches.push({ id: id("batch"), createdBy: user.id, createdAt: now(), rows: generated });
      writeDb(db);
    }
    return send(res, 200, { rows: generated, csv: toCsv(generated.map((r) => ({ "Student Name": r.name, Class: r.className, Username: r.username, "Temporary Password": r.temporaryPassword, Role: r.role, "Created At": r.createdAt }))) });
  }

  if (method === "POST" && url.pathname === "/api/admin/assign-grader") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const submission = db.submissions.find((s) => s.id === body.submissionId);
    const grader = db.users.find((u) => u.id === body.graderId && u.role === "grader");
    if (!submission || !grader) return send(res, 404, { error: "Submission or grader not found" });
    const existing = db.graderAssignments.find((a) => a.submissionId === submission.id && a.graderId === grader.id);
    const alreadyReviewed = ["writing", "speaking"].includes(submission.type) && [...db.writingGrades, ...db.speakingGrades].some((g) => g.submissionId === submission.id && g.status === "Reviewed");
    submission.status = alreadyReviewed ? "Reviewed" : "Assigned";
    if (existing) {
      existing.assignedByAdminId = user.id;
      existing.status = submission.status;
      existing.reviewedAt = alreadyReviewed ? now() : existing.reviewedAt;
    } else {
      db.graderAssignments.push({ id: id("assign"), submissionId: submission.id, graderId: grader.id, assignedByAdminId: user.id, status: submission.status, assignedAt: now(), reviewedAt: alreadyReviewed ? now() : null });
    }
    writeDb(db);
    return send(res, 201, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/grader/grade") {
    const user = requireRole(req, res, db, ["grader", "super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const submission = db.submissions.find((s) => s.id === body.submissionId);
    if (!submission) return send(res, 404, { error: "Submission not found" });
    const assigned = db.graderAssignments.find((a) => a.submissionId === submission.id && (a.graderId === user.id || ["super_admin", "admin"].includes(user.role)));
    if (!assigned && user.role === "grader") return send(res, 403, { error: "Only assigned submissions can be graded" });
    const collection = submission.type === "speaking" ? db.speakingGrades : db.writingGrades;
    let grade = [...collection].reverse().find((g) => g.submissionId === submission.id && (g.graderId === user.id || ["super_admin", "admin"].includes(user.role)));
    const gradeData = { ...body.scores, overallBand: Number(body.overallBand), feedback: body.feedback || "", status: body.final ? "Reviewed" : "In Review", updatedAt: now() };
    if (grade) {
      Object.assign(grade, gradeData);
    } else {
      grade = { id: id("grade"), submissionId: submission.id, graderId: user.id, ...gradeData, createdAt: now() };
      collection.push(grade);
    }
    submission.estimatedBand = grade.overallBand;
    submission.status = body.final ? "Reviewed" : "In Review";
    if (assigned) {
      assigned.status = submission.status;
      assigned.reviewedAt = body.final ? now() : null;
    }
    writeDb(db);
    return send(res, 201, { grade });
  }

  if (method === "POST" && url.pathname === "/api/grader/objective-score") {
    const user = requireRole(req, res, db, ["grader", "super_admin", "admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const submission = db.submissions.find((s) => s.id === body.submissionId);
    if (!submission) return send(res, 404, { error: "Submission not found" });
    if (!["listening", "reading"].includes(submission.type)) return send(res, 400, { error: "Only Listening and Reading scores can be edited here" });
    const score = Math.max(0, Math.min(40, Number(body.score)));
    if (!Number.isFinite(score)) return send(res, 400, { error: "Score must be a number" });
    submission.score = score;
    submission.estimatedBand = body.estimatedBand === "" || body.estimatedBand == null ? bandFromRaw(score) : Number(body.estimatedBand);
    submission.status = body.status || "Returned to Student";
    submission.reviewedBy = user.id;
    submission.reviewedAt = now();
    writeDb(db);
    return send(res, 200, { submission });
  }

  if (method === "GET" && url.pathname === "/api/admin/export") {
    const user = requireRole(req, res, db, ["super_admin", "admin"]);
    if (!user) return;
    const type = url.searchParams.get("type") || "results";
    let rows = [];
    if (type === "accounts") rows = db.users.filter((u) => u.role === "student").map((u) => ({ name: u.name, className: u.className, username: u.username, role: u.role, createdAt: u.createdAt }));
    else rows = db.submissions.map((s) => {
      const student = db.users.find((u) => u.id === s.userId) || {};
      return { student: student.name, className: student.className, testId: s.testId, type: s.type, score: s.score ?? "", band: s.estimatedBand ?? "", status: s.status, submittedAt: s.submittedAt };
    });
    return send(res, 200, toCsv(rows), { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${type}.csv"` });
  }

  return send(res, 404, { error: "API route not found" });
}

function gradesFor(db, submissionId) {
  return [...db.writingGrades, ...db.speakingGrades].filter((g) => g.submissionId === submissionId);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(PUBLIC, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC, "index.html");
  const ext = path.extname(filePath);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

ensureDb();
http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) api(req, res).catch((error) => send(res, 500, { error: error.message }));
  else serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`BandPrep Mock Test running at http://localhost:${PORT}`);
});
