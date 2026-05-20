const h = React.createElement;
const { useEffect, useMemo, useState } = React;

const DISCLAIMER = "This website is an independent IELTS practice platform. It is not affiliated with IELTS, British Council, IDP, or Cambridge.";

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const text = await res.text();
  const data = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function App() {
  const [route, setRoute] = useState(location.hash.replace("#", "") || "home");
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState("");

  useEffect(() => {
    const onHash = () => setRoute(location.hash.replace("#", "") || "home");
    addEventListener("hashchange", onHash);
    api("/api/me").then((d) => setMe(d.user)).finally(() => setLoading(false));
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const go = (next) => { location.hash = next; setRoute(next); };
  const logout = async () => { await api("/api/auth/logout", { method: "POST" }); setMe(null); go("home"); };

  if (loading) return h(Layout, { me, go }, h("div", { className: "shell" }, "Loading..."));

  let page;
  if (route === "home") page = h(Landing, { go });
  else if (route === "login") page = h(Login, { setMe, go });
  else if (!me) page = h(Login, { setMe, go });
  else if (route === "dashboard") page = h(StudentDashboard, { me, go });
  else if (route === "tests") page = h(TestList, { go });
  else if (route.startsWith("take/")) page = h(TestRunner, { testId: route.split("/")[1], go });
  else if (route === "results") page = h(Results, { me, go });
  else if (route.startsWith("result/")) page = h(ResultDetail, { id: route.split("/")[1] });
  else if (route === "admin") page = h(AdminDashboard, { me, flash, setFlash });
  else if (route === "grader") page = h(GraderDashboard, { me });
  else page = h(Landing, { go });

  return h(Layout, { me, go, logout }, page);
}

function Layout({ me, go, logout, children }) {
  const canAdmin = me && ["super_admin", "admin"].includes(me.role);
  const canGrade = me && me.role === "grader";
  return h("div", { className: "app" },
    h("header", { className: "topbar" },
      h("div", { className: "topbar-inner" },
        h("div", { className: "brand" }, "BandPrep"),
        h("nav", { className: "nav" },
          h("button", { onClick: () => go("home") }, "Home"),
          h("button", { onClick: () => go("tests") }, "Tests"),
          me && h("button", { onClick: () => go("dashboard") }, "Dashboard"),
          canAdmin && h("button", { onClick: () => go("admin") }, "Admin"),
          canGrade && h("button", { onClick: () => go("grader") }, "Grader"),
          me ? h("button", { onClick: logout }, "Logout") : h("button", { onClick: () => go("login") }, "Login")
        )
      )
    ),
    h("main", { className: "main" }, children),
    h("footer", { className: "footer" }, DISCLAIMER)
  );
}

function Landing({ go }) {
  const features = ["Listening Practice", "Reading Practice", "Writing Tasks", "Speaking Practice", "Band Score Estimate", "Teacher Feedback"];
  return h(React.Fragment, null,
    h("section", { className: "hero" },
      h("div", { className: "hero-grid" },
        h("div", null,
          h("div", { className: "eyebrow" }, "Independent IELTS-style practice"),
          h("h1", null, "Practice IELTS with realistic mock tests"),
          h("p", null, "Improve your Listening, Reading, Writing, and Speaking skills with timed practice tests and detailed results."),
          h("div", { className: "actions" },
            h("button", { className: "btn", onClick: () => go("login") }, "Start Practice"),
            h("button", { className: "btn secondary", onClick: () => go("tests") }, "View Sample Test")
          )
        ),
        h("div", { className: "hero-panel" },
          h("h3", null, "Mock exam workflow"),
          h("div", { className: "exam-strip" }, ["Timed test", "Auto-save answers", "Band estimate", "Teacher review"].map((label, i) =>
            h("div", { className: "exam-row", key: label },
              h("div", { className: "exam-num" }, i + 1),
              h("div", null, h("strong", null, label), h("p", { style: { margin: 0 } }, ["Listening and Reading scoring", "Writing and Speaking grading", "Class reports and exports", "Feedback returned to students"][i])),
              h("span", { className: "badge green" }, "Ready")
            )
          ))
        )
      )
    ),
    h("section", { className: "shell" },
      h("h2", null, "Practice tools"),
      h("div", { className: "grid cards" }, features.map((feature) => h("div", { className: "card", key: feature }, h("h3", null, feature), h("p", null, "Focused IELTS-style practice with clean timing, review, and reporting tools."))))
    )
  );
}

function Login({ setMe, go }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const data = await api("/api/auth/login", { method: "POST", body: form });
      setMe(data.user);
      go(data.user.role === "grader" ? "grader" : ["admin", "super_admin"].includes(data.user.role) ? "admin" : "dashboard");
    } catch (err) { setError(err.message); }
  };
  return h("div", { className: "shell" },
    h("div", { className: "grid two" },
      h("div", null, h("h2", null, "Login"), h("p", null, "Students use their school-issued username and temporary password. Staff accounts use their assigned role credentials.")),
      h("form", { className: "card form", onSubmit: submit },
        error && h("div", { className: "error" }, error),
        h(Field, { label: "Username", value: form.username, onChange: (v) => setForm({ ...form, username: v }) }),
        h(Field, { label: "Password", type: "password", value: form.password, onChange: (v) => setForm({ ...form, password: v }) }),
        h("button", { className: "btn" }, "Login")
      )
    )
  );
}

function StudentDashboard({ me, go }) {
  const [results, setResults] = useState([]);
  useEffect(() => { api("/api/results").then((d) => setResults(d.submissions)); }, []);
  const completed = results.length;
  const avg = results.length ? (results.reduce((a, r) => a + Number(r.estimatedBand || 0), 0) / results.length).toFixed(1) : "0.0";
  const skill = (type) => [...results].reverse().find((r) => r.type === type)?.estimatedBand || "-";
  return h("div", { className: "shell" },
    h("div", { className: "actions", style: { justifyContent: "space-between" } }, h("div", null, h("h2", null, `Welcome, ${me.name}`), h("p", null, `${me.className || "BandPrep"} practice dashboard`)), h("button", { className: "btn", onClick: () => go("tests") }, "Start New Test")),
    h("div", { className: "grid cards" },
      metric("Completed Tests", completed), metric("Average Band Score", avg), metric("Reading Score", skill("reading")),
      metric("Listening Score", skill("listening")), metric("Writing Score", skill("writing")), metric("Speaking Score", skill("speaking"))
    ),
    h("div", { className: "card", style: { marginTop: 18 } }, h("h3", null, "Recent mock test results"), h(ResultTable, { rows: results.slice().reverse(), go }))
  );
}

function metric(label, value) {
  return h("div", { className: "card metric" }, h("span", null, label), h("strong", null, value));
}

function TestList({ go }) {
  const [tests, setTests] = useState([]);
  useEffect(() => { api("/api/tests").then((d) => setTests(d.tests)); }, []);
  return h("div", { className: "shell" },
    h("h2", null, "Mock tests"),
    h("div", { className: "grid cards" }, tests.map((test) =>
      h("div", { className: "card", key: test.id },
        h("span", { className: "badge" }, test.type.replace("_", " ")),
        h("h3", { style: { marginTop: 12 } }, test.title),
        h("p", null, `${test.duration} minutes · ${test.questionCount || "Practice"} questions`),
        test.scheduleStatus?.scheduled && test.startsAt && h("div", { className: "schedule-box" },
          h("strong", null, "Official test window"),
          h("span", null, `Starts: ${formatDateTime(test.startsAt)}`),
          h("span", null, `Ends: ${formatDateTime(test.endsAt)}`),
          h("span", { className: test.scheduleStatus?.available ? "correct" : "muted" }, scheduleLabel(test.scheduleStatus))
        ),
        h("button", { type: "button", className: `btn ${test.scheduleStatus?.scheduled && !test.scheduleStatus.available ? "disabled" : ""}`, disabled: test.scheduleStatus?.scheduled && !test.scheduleStatus.available, onClick: () => go(`take/${test.id}`) }, test.scheduleStatus?.scheduled && test.scheduleStatus.notStarted ? "Not Started" : test.scheduleStatus?.scheduled && test.scheduleStatus.ended ? "Closed" : "Start")
      )
    ))
  );
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scheduleLabel(status) {
  if (!status?.scheduled) return "Open practice";
  if (status.available) return "Open now";
  if (status.notStarted) return "Waiting to start";
  return "Closed";
}

function Timer({ minutes, onEnd }) {
  const initialLeft = minutes * 60;
  const [left, setLeft] = useState(initialLeft);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => {
      const next = v - 1;
      if (next <= 0) { clearInterval(t); onEnd?.(); return 0; }
      return next;
    }), 1000);
    return () => clearInterval(t);
  }, [minutes]);
  return h("div", { className: "timer" }, `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`);
}

function TestRunner({ testId, go }) {
  const [test, setTest] = useState(null);
  const [answers, setAnswers] = useState(() => JSON.parse(localStorage.getItem(`answers:${testId}`) || "{}"));
  const [index, setIndex] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState(() => JSON.parse(localStorage.getItem(`draft:${testId}`) || "{}"));
  const [loadError, setLoadError] = useState("");
  useEffect(() => { api(`/api/tests/${testId}`).then((d) => setTest(d.test)).catch((err) => setLoadError(err.message)); }, [testId]);
  useEffect(() => { localStorage.setItem(`answers:${testId}`, JSON.stringify(answers)); }, [answers]);
  useEffect(() => { localStorage.setItem(`draft:${testId}`, JSON.stringify(draft)); }, [draft]);
  if (loadError) return h("div", { className: "shell" }, h("div", { className: "error" }, loadError), h("button", { type: "button", className: "btn secondary", onClick: () => go("tests"), style: { marginTop: 14 } }, "Back to Tests"));
  if (!test) return h("div", { className: "shell" }, "Loading test...");

  const submit = async () => {
    const payload = test.type === "writing" ? { testId, task1Answer: draft.task1 || "", task2Answer: draft.task2 || "", answers: {} }
      : test.type === "speaking" ? { testId, answers: draft, audioUrl: draft.audioUrl || "" }
      : { testId, answers, timeSpent: 0 };
    const data = await api("/api/submissions", { method: "POST", body: payload });
    localStorage.removeItem(`answers:${testId}`);
    go(`result/${data.submission.id}`);
  };

  const questions = test.questions || [];
  return h(React.Fragment, null,
    h("div", { className: "exam-top" }, h("div", { className: "shell" }, h("div", null, h("strong", null, test.title), h("div", { className: "muted" }, `${test.duration} minute timer`)), h(Timer, { minutes: test.duration, onEnd: submit }))),
    h("div", { className: "shell" },
      test.type === "reading" && h(ReadingView, { test, questions, answers, setAnswers, index, setIndex }),
      test.type === "listening" && h(ListeningView, { test, questions, answers, setAnswers, index, setIndex }),
      test.type === "writing" && h(WritingView, { test, draft, setDraft }),
      test.type === "speaking" && h(SpeakingView, { test, draft, setDraft }),
      h("div", { className: "actions", style: { marginTop: 18 } },
        questions.length > 0 && h("button", { className: "btn secondary", onClick: () => setIndex(Math.max(0, index - 1)) }, "Previous"),
        questions.length > 0 && h("button", { className: "btn secondary", onClick: () => setIndex(Math.min(questions.length - 1, index + 1)) }, "Next"),
        h("button", { className: "btn ghost", onClick: () => alert("Question flagged for review.") }, "Flag Question"),
        h("button", { className: "btn", onClick: () => setConfirm(true) }, "Submit")
      )
    ),
    confirm && h(Modal, { title: "Submit test?", onClose: () => setConfirm(false) },
      h("p", null, "Your answers will be submitted and the timer will stop."),
      h("div", { className: "actions" }, h("button", { className: "btn secondary", onClick: () => setConfirm(false) }, "Keep Working"), h("button", { className: "btn", onClick: submit }, "Final Submit"))
    )
  );
}

function ListeningView(props) {
  const currentQuestion = props.questions[props.index];
  const currentSection = (props.test.sections || [])[Number(currentQuestion?.section || 1) - 1];
  return h("div", { className: "exam-layout" }, h(Navigator, props), h("div", { className: "grid" },
    h("div", { className: "card" }, h("h3", null, "Audio Player"), h("audio", { controls: true, style: { width: "100%" }, src: props.test.audioUrl || undefined }), h("p", null, "Audio can be uploaded by an admin as a URL for local practice.")),
    currentSection?.image && h("div", { className: "card" }, h("h3", null, currentSection.title), h("p", null, currentSection.instructions), h("img", { className: "task-image", src: currentSection.image, alt: currentSection.title })),
    h(QuestionCard, props)
  ));
}

function ReadingView(props) {
  return h("div", { className: "split" },
    h("div", { className: "card passage" }, h("h3", null, props.test.passageTitle), props.test.passage),
    h("div", { className: "exam-layout" }, h(Navigator, props), h(QuestionCard, props))
  );
}

function Navigator({ questions, index, setIndex, answers }) {
  return h("aside", { className: "card" }, h("h3", null, "Questions"), h("div", { className: "question-nav" }, questions.map((q, i) =>
    h("button", { key: q.id, className: `${i === index ? "active" : ""} ${answers[q.id] ? "answered" : ""}`, onClick: () => setIndex(i) }, q.number)
  )));
}

function QuestionCard({ questions, index, answers, setAnswers }) {
  const question = questions[index];
  if (!question) return null;
  return h("div", { className: "card question-card" },
    h("span", { className: "badge" }, `Question ${question.number}`),
    h("h3", null, question.questionText),
    ["mcq", "tfng"].includes(question.questionType)
      ? h("div", { className: "grid" }, question.options.map((op) => h("label", { className: "option", key: op }, h("input", { type: "radio", name: question.id, checked: answers[question.id] === op, onChange: () => setAnswers({ ...answers, [question.id]: op }) }), op)))
      : h("input", { className: "input", value: answers[question.id] || "", onChange: (e) => setAnswers({ ...answers, [question.id]: e.target.value }), placeholder: "Type your answer" })
  );
}

function WritingView({ test, draft, setDraft }) {
  const wc = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return h("div", { className: "grid two" },
    h("div", { className: "card" }, h("div", { className: "actions", style: { justifyContent: "space-between" } }, h("h3", null, "Writing Task 1"), h("span", { className: "badge" }, "20 minutes")), h("p", null, test.task1), test.task1Image && h("img", { className: "task-image", src: test.task1Image, alt: "IELTS Writing Task 1 visual prompt" }), h("textarea", { value: draft.task1 || "", onChange: (e) => setDraft({ ...draft, task1: e.target.value }) }), h("div", { className: "wordbar" }, h("span", null, `${wc(draft.task1)} words`), wc(draft.task1) < 150 && h("span", { className: "incorrect" }, "Minimum 150 words"))),
    h("div", { className: "card" }, h("div", { className: "actions", style: { justifyContent: "space-between" } }, h("h3", null, "Writing Task 2"), h("span", { className: "badge" }, "40 minutes")), h("p", null, test.task2), h("textarea", { value: draft.task2 || "", onChange: (e) => setDraft({ ...draft, task2: e.target.value }) }), h("div", { className: "wordbar" }, h("span", null, `${wc(draft.task2)} words`), wc(draft.task2) < 250 && h("span", { className: "incorrect" }, "Minimum 250 words")))
  );
}

function SpeakingView({ test, draft, setDraft }) {
  return h("div", { className: "grid" },
    h("div", { className: "card" }, h("h3", null, "Recorder"), h("p", null, "Use your device recorder and paste the saved audio URL, or type notes below."), h(Field, { label: "Audio URL", value: draft.audioUrl || "", onChange: (v) => setDraft({ ...draft, audioUrl: v }) })),
    ...test.parts.map((part, i) => h("div", { className: "card", key: part.title }, h("h3", null, part.title), part.cue && h("p", null, part.cue), (part.questions || []).map((q) => h("p", { key: q }, q)), i === 1 && h("div", { className: "actions" }, h("span", { className: "badge gold" }, "1-minute prep"), h("span", { className: "badge" }, "2-minute speaking")), h("textarea", { value: draft[part.title] || "", onChange: (e) => setDraft({ ...draft, [part.title]: e.target.value }), placeholder: "Save speaking notes or transcript" })))
  );
}

function Results({ go }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api("/api/results").then((d) => setRows(d.submissions)); }, []);
  return h("div", { className: "shell" }, h("h2", null, "Results"), h("div", { className: "card" }, h(ResultTable, { rows, go })));
}

function ResultTable({ rows, go }) {
  if (!rows.length) return h("p", null, "No submissions yet.");
  return h("div", { className: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, ["Student", "Test", "Type", "Score", "Band", "Status", "Submitted", ""].map((x) => h("th", { key: x }, x)))),
    h("tbody", null, rows.map((r) => h("tr", { key: r.id },
      h("td", null, r.student?.name || "You"), h("td", null, r.testId), h("td", null, r.type), h("td", null, r.score ?? "-"), h("td", null, r.estimatedBand ?? "-"),
      h("td", null, h("span", { className: "badge" }, r.status)), h("td", null, new Date(r.submittedAt).toLocaleString()), h("td", null, h("button", { className: "btn small secondary", onClick: () => go(`result/${r.id}`) }, "Open"))
    )))
  ));
}

function ObjectiveScoreEditor({ submission, onSaved }) {
  const [form, setForm] = useState({ score: submission.score ?? 0, estimatedBand: submission.estimatedBand ?? "", status: submission.status || "Returned to Student" });
  const save = async () => {
    const data = await api("/api/grader/objective-score", { method: "POST", body: { submissionId: submission.id, ...form } });
    onSaved(data.submission);
  };
  return h("div", { className: "card", style: { marginTop: 18 } },
    h("h3", null, "Edit Listening / Reading Score"),
    h("div", { className: "grid cards" },
      h(Field, { label: "Raw Score", type: "number", min: 0, max: 40, step: 1, value: form.score, onChange: (v) => setForm({ ...form, score: Number(v) }) }),
      h(Field, { label: "Band", type: "number", min: 0, max: 9, step: 0.5, value: form.estimatedBand, onChange: (v) => setForm({ ...form, estimatedBand: Number(v) }) }),
      h("div", { className: "field" }, h("label", null, "Status"), h("select", { className: "input", value: form.status, onChange: (e) => setForm({ ...form, status: e.target.value }) }, ["Returned to Student", "Reviewed", "In Review"].map((s) => h("option", { key: s, value: s }, s))))
    ),
    h("button", { type: "button", className: "btn", onClick: save, style: { marginTop: 12 } }, "Save Score")
  );
}

function ResultDetail({ id }) {
  const [data, setData] = useState(null);
  useEffect(() => { api(`/api/results/${id}`).then(setData); }, [id]);
  if (!data) return h("div", { className: "shell" }, "Loading result...");
  const s = data.submission;
  return h("div", { className: "shell" },
    h("h2", null, "Result Summary"),
    h("div", { className: "grid cards" }, metric("Total Score", s.score ?? "Teacher Review"), metric("Estimated IELTS Band", s.estimatedBand ?? "Pending"), metric("Time Spent", `${Math.round((s.timeSpent || 0) / 60)} min`)),
    s.details && h("div", { className: "card", style: { marginTop: 18 } }, h("h3", null, "Answer Review"), s.details.map((d) => h("div", { key: d.questionId, className: "card", style: { marginTop: 10 } }, h("strong", null, `Q${d.number}: ${d.questionText}`), h("p", null, "Your answer: ", d.answer || "-"), h("p", { className: d.correct ? "correct" : "incorrect" }, d.correct ? "Correct" : `Incorrect · Correct answer: ${d.correctAnswer}`), h("p", null, d.explanation)))),
    ["listening", "reading"].includes(s.type) && h(ObjectiveScoreEditor, { submission: s, onSaved: (submission) => setData({ ...data, submission }) }),
    data.grades?.length > 0 && h("div", { className: "card", style: { marginTop: 18 } }, h("h3", null, "Teacher Feedback"), data.grades.map((g) => h("p", { key: g.id }, `Band ${g.overallBand}: ${g.feedback}`))),
    h("div", { className: "card", style: { marginTop: 18 } }, h("h3", null, "Weak Areas"), h("p", null, "Review incorrect question types and teacher feedback. Example weak areas: Matching headings, True/False/Not Given, task response, pronunciation."))
  );
}

function AdminDashboard({ me, flash, setFlash }) {
  const tabs = ["User Management", "Student Import", "Account Generator", "Test Management", "Question Bank", "Grader Assignment", "Results", "Reports", "Settings"];
  const [tab, setTab] = useState(tabs[0]);
  const changeTab = (next) => {
    setFlash("");
    setTab(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return h("div", { className: "shell grid dashboard" },
    h("aside", { className: "sidebar admin-sidebar" }, tabs.map((t) => h("button", { type: "button", key: t, className: tab === t ? "active" : "", onClick: () => changeTab(t) }, t))),
    h("section", { className: "admin-content" },
      h("div", { className: "field admin-tab-select" }, h("label", null, "Admin Section"), h("select", { className: "input", value: tab, onChange: (e) => changeTab(e.target.value) }, tabs.map((t) => h("option", { key: t, value: t }, t)))),
      h("div", { className: "admin-quick-actions" }, tabs.map((t) => h("button", { type: "button", key: `quick-${t}`, className: tab === t ? "active" : "", onClick: () => changeTab(t) }, t))),
      h("h2", null, tab), flash && h("div", { className: "notice" }, flash),
      tab === "User Management" && h(UserManagement, { me, setFlash }),
      tab === "Student Import" && h(StudentImport, { setFlash }),
      tab === "Account Generator" && h(AccountGenerator, { setFlash }),
      tab === "Test Management" && h(TestManagement, { setFlash }),
      tab === "Question Bank" && h(QuestionBank, { setFlash }),
      tab === "Grader Assignment" && h(GraderAssignment, { setFlash }),
      tab === "Results" && h(Results, { go: (r) => location.hash = r }),
      tab === "Reports" && h(Reports),
      tab === "Settings" && h("div", { className: "card" }, h("h3", null, "Settings"), h("p", null, "First-login password change is enabled for imported students. Temporary passwords are shown only at generation or reset time."))
    )
  );
}

function UserManagement({ setFlash }) {
  const [users, setUsers] = useState([]);
  const load = () => api("/api/admin/users").then((d) => setUsers(d.users));
  useEffect(() => { load(); }, []);
  const reset = async (id) => {
    const d = await api(`/api/admin/users/${id}/reset-password`, { method: "POST" });
    setFlash(`Temporary password for ${d.user.name}: ${d.temporaryPassword}`);
    load();
  };
  return h("div", { className: "card" }, h("div", { className: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, ["Name", "Username", "Class", "Role", "Active", ""].map((x) => h("th", { key: x }, x)))),
    h("tbody", null, users.map((u) => h("tr", { key: u.id }, h("td", null, u.name), h("td", null, u.username), h("td", null, u.className), h("td", null, u.role), h("td", null, u.isActive ? "Yes" : "No"), h("td", null, h("button", { type: "button", className: "btn small secondary", onClick: () => reset(u.id) }, "Reset Password")))))
  )));
}

function StudentImport({ setFlash }) {
  const [csv, setCsv] = useState("name,class,email,phone,parentName\nSample Student,11A,sample@example.com,,Parent");
  const [preview, setPreview] = useState(null);
  const run = async (commit) => {
    const d = await api("/api/admin/import-students", { method: "POST", body: { csv, commit } });
    setPreview(d);
    setFlash(commit ? `Created ${d.rows.length} student accounts.` : `Previewed ${d.rows.length} student accounts.`);
  };
  return h("div", { className: "grid" },
    h("div", { className: "card" }, h("p", null, "Paste CSV columns: name,class,email,phone,parentName"), h("textarea", { value: csv, onChange: (e) => setCsv(e.target.value) }), h("div", { className: "actions" }, h("button", { type: "button", className: "btn secondary", onClick: () => run(false) }, "Preview"), h("button", { type: "button", className: "btn", onClick: () => run(true) }, "Create Accounts"))),
    preview && h(CredentialPreview, { rows: preview.rows, csv: preview.csv })
  );
}

function AccountGenerator({ setFlash }) {
  const [form, setForm] = useState({ name: "", className: "11A", email: "", role: "student" });
  const [created, setCreated] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const d = await api("/api/admin/users", { method: "POST", body: form });
      setCreated([{ name: d.user.name, className: d.user.className, username: d.user.username, temporaryPassword: d.temporaryPassword, role: d.user.role, createdAt: d.user.createdAt }]);
      setFlash("Account created.");
    } catch (err) { setFlash(err.message); }
  };
  return h("div", { className: "grid" }, h("form", { className: "card form", onSubmit: submit },
    h(Field, { label: "Student Name", value: form.name, onChange: (v) => setForm({ ...form, name: v }) }),
    h(Field, { label: "Class", value: form.className, onChange: (v) => setForm({ ...form, className: v }) }),
    h(Field, { label: "Email", value: form.email, onChange: (v) => setForm({ ...form, email: v }) }),
    h("button", { type: "submit", className: "btn" }, "Generate Account")
  ), created && h(CredentialPreview, { rows: created, csv: "" }));
}

function TestManagement({ setFlash }) {
  const [tests, setTests] = useState([]);
  const [form, setForm] = useState({ title: "", type: "listening", duration: 40, audioUrl: "", passageTitle: "", passage: "", task1: "", task1Image: "", task2: "" });
  const load = () => api("/api/tests").then((d) => setTests(d.tests));
  useEffect(() => { load(); }, []);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/tests", { method: "POST", body: form });
      setForm({ title: "", type: "listening", duration: 40, audioUrl: "", passageTitle: "", passage: "", task1: "", task1Image: "", task2: "" });
      setFlash("Test created.");
      load();
    } catch (err) { setFlash(err.message); }
  };
  return h("div", { className: "grid two" },
    h("form", { className: "card form", onSubmit: submit },
      h(Field, { label: "Title", value: form.title, onChange: (v) => setForm({ ...form, title: v }) }),
      h("div", { className: "field" }, h("label", null, "Type"), h("select", { className: "input", value: form.type, onChange: (e) => setForm({ ...form, type: e.target.value }) }, ["listening", "reading", "writing", "speaking", "full_mock"].map((type) => h("option", { key: type, value: type }, type)))),
      h(Field, { label: "Duration", type: "number", value: form.duration, onChange: (v) => setForm({ ...form, duration: Number(v) }) }),
      form.type === "listening" && h(Field, { label: "Audio URL", value: form.audioUrl, required: false, onChange: (v) => setForm({ ...form, audioUrl: v }) }),
      form.type === "reading" && h(Field, { label: "Passage Title", value: form.passageTitle, onChange: (v) => setForm({ ...form, passageTitle: v }) }),
      form.type === "reading" && h("textarea", { placeholder: "Reading passage", value: form.passage, onChange: (e) => setForm({ ...form, passage: e.target.value }) }),
      form.type === "writing" && h("textarea", { placeholder: "Task 1 prompt", value: form.task1, onChange: (e) => setForm({ ...form, task1: e.target.value }) }),
      form.type === "writing" && h(Field, { label: "Task 1 Image", value: form.task1Image, required: false, onChange: (v) => setForm({ ...form, task1Image: v }) }),
      form.type === "writing" && h("textarea", { placeholder: "Task 2 prompt", value: form.task2, onChange: (e) => setForm({ ...form, task2: e.target.value }) }),
      h("button", { type: "submit", className: "btn" }, "Create Test")
    ),
    h("div", { className: "card" }, h("h3", null, "Existing Tests"), h("div", { className: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Title", "Type", "Duration", "Questions"].map((x) => h("th", { key: x }, x)))),
      h("tbody", null, tests.map((t) => h("tr", { key: t.id }, h("td", null, t.title), h("td", null, t.type), h("td", null, `${t.duration}m`), h("td", null, t.questionCount))))
    )))
  );
}

function QuestionBank({ setFlash }) {
  const [tests, setTests] = useState([]);
  const [form, setForm] = useState({ testId: "", section: 1, number: "", questionText: "", questionType: "blank", options: "", correctAnswer: "", explanation: "" });
  useEffect(() => { api("/api/tests").then((d) => { const eligible = d.tests.filter((t) => ["listening", "reading"].includes(t.type)); setTests(eligible); setForm((f) => ({ ...f, testId: f.testId || eligible[0]?.id || "" })); }); }, []);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/questions", { method: "POST", body: form });
      setForm({ ...form, number: "", questionText: "", options: "", correctAnswer: "", explanation: "" });
      setFlash("Question added.");
    } catch (err) { setFlash(err.message); }
  };
  return h("form", { className: "card form", onSubmit: submit },
    h("div", { className: "field" }, h("label", null, "Test"), h("select", { className: "input", value: form.testId, onChange: (e) => setForm({ ...form, testId: e.target.value }) }, tests.map((t) => h("option", { key: t.id, value: t.id }, `${t.title} (${t.type})`)))),
    h(Field, { label: "Section", type: "number", value: form.section, onChange: (v) => setForm({ ...form, section: Number(v) }) }),
    h(Field, { label: "Number", type: "number", value: form.number, onChange: (v) => setForm({ ...form, number: Number(v) }) }),
    h("div", { className: "field" }, h("label", null, "Question Type"), h("select", { className: "input", value: form.questionType, onChange: (e) => setForm({ ...form, questionType: e.target.value }) }, ["blank", "mcq", "tfng", "matching", "short_answer"].map((type) => h("option", { key: type, value: type }, type)))),
    h("textarea", { placeholder: "Question text", value: form.questionText, onChange: (e) => setForm({ ...form, questionText: e.target.value }) }),
    ["mcq", "tfng", "matching"].includes(form.questionType) && h("textarea", { placeholder: "Options, one per line", value: form.options, onChange: (e) => setForm({ ...form, options: e.target.value }) }),
    h(Field, { label: "Correct Answer", value: form.correctAnswer, onChange: (v) => setForm({ ...form, correctAnswer: v }) }),
    h("textarea", { placeholder: "Explanation", value: form.explanation, onChange: (e) => setForm({ ...form, explanation: e.target.value }) }),
    h("button", { type: "submit", className: "btn" }, "Add Question")
  );
}

function CredentialPreview({ rows, csv }) {
  return h("div", { className: "card" },
    h("div", { className: "actions no-print" }, h("button", { type: "button", className: "btn secondary", onClick: () => download("student_credentials.csv", csv || rowsToCsv(rows)) }, "Download CSV"), h("button", { type: "button", className: "btn secondary", onClick: () => print() }, "Print Login Cards")),
    h("div", { className: "table-wrap no-print" }, h("table", null, h("thead", null, h("tr", null, ["Student Name", "Class", "Username", "Temporary Password", "Role", "Created At"].map((x) => h("th", { key: x }, x)))), h("tbody", null, rows.map((r) => h("tr", { key: r.username }, h("td", null, r.name), h("td", null, r.className), h("td", null, r.username), h("td", null, r.temporaryPassword), h("td", null, r.role), h("td", null, r.createdAt)))))),
    h("div", { className: "grid cards", style: { marginTop: 16 } }, rows.map((r) => h("div", { className: "print-card", key: `card-${r.username}` }, h("h3", null, "Student IELTS Mock Test Login"), h("p", null, `Name: ${r.name}`), h("p", null, `Class: ${r.className}`), h("p", null, `Username: ${r.username}`), h("p", null, `Password: ${r.temporaryPassword}`), h("p", null, `Website: ${location.origin}`), h("p", null, "Please change your password after first login."))))
  );
}

function GraderAssignment({ setFlash }) {
  const [results, setResults] = useState([]);
  const [users, setUsers] = useState([]);
  const [open, setOpen] = useState(null);
  const load = () => api("/api/results").then((d) => setResults(d.submissions));
  useEffect(() => { load(); api("/api/admin/users").then((d) => setUsers(d.users)); }, []);
  const graders = users.filter((u) => u.role === "grader");
  const assign = async (submissionId, graderId) => {
    await api("/api/admin/assign-grader", { method: "POST", body: { submissionId, graderId } });
    setFlash("Submission assigned.");
  };
  return h(React.Fragment, null,
    h("div", { className: "card table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Type", "Status", "Assign", "Grade"].map((x) => h("th", { key: x }, x)))),
      h("tbody", null, results.filter((r) => ["writing", "speaking"].includes(r.type)).map((r) => h("tr", { key: r.id },
        h("td", null, r.student?.name),
        h("td", null, r.type),
        h("td", null, r.status),
        h("td", null, h("select", { onChange: (e) => e.target.value && assign(r.id, e.target.value) }, h("option", null, "Choose grader"), graders.map((g) => h("option", { key: g.id, value: g.id }, g.name)))),
        h("td", null, h("button", { type: "button", className: "btn small secondary", onClick: () => setOpen(r.id) }, ["listening", "reading"].includes(r.type) ? "Review Answers" : r.status === "Reviewed" ? "Edit" : "Open"))
      )))
    )),
    open && h(GradeModal, { id: open, onClose: () => setOpen(null), onSaved: load })
  );
}

function GraderDashboard() {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const load = () => api("/api/results").then((d) => setRows(d.submissions));
  useEffect(() => { load(); }, []);
  return h("div", { className: "shell" },
    h("h2", null, "Grader Dashboard"),
    h("div", { className: "card" }, h("div", { className: "actions" }, h("select", null, h("option", null, "Filter by class")), h("select", null, h("option", null, "Filter by status")), h("input", { className: "input", type: "date", style: { maxWidth: 180 } })), h(ResultTable, { rows, go: (r) => setOpen(r.split("/")[1]) })),
    open && h(GradeModal, { id: open, onClose: () => setOpen(null), onSaved: load })
  );
}

function GradeModal({ id, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ overallBand: 6.5, feedback: "", scores: {} });
  const [objectiveForm, setObjectiveForm] = useState({ score: 0, estimatedBand: "", status: "Reviewed" });
  useEffect(() => { api(`/api/results/${id}`).then(setData); }, [id]);
  useEffect(() => {
    if (!data?.grades?.length) return;
    const latest = data.grades[data.grades.length - 1];
    const { overallBand, feedback, id: gradeId, submissionId, graderId, status, createdAt, updatedAt, ...scores } = latest;
    setForm({ overallBand: overallBand ?? 6.5, feedback: feedback || "", scores });
  }, [data]);
  useEffect(() => {
    if (!data?.submission || !["listening", "reading"].includes(data.submission.type)) return;
    const submission = data.submission;
    setObjectiveForm({ score: submission.score ?? 0, estimatedBand: submission.estimatedBand ?? "", status: submission.status || "Reviewed" });
  }, [data]);
  const submit = async (final) => {
    await api("/api/grader/grade", { method: "POST", body: { submissionId: id, ...form, final } });
    await onSaved?.();
    onClose();
  };
  if (!data) return null;
  const s = data.submission;
  if (["listening", "reading"].includes(s.type)) {
    const saveObjective = async () => {
      await api("/api/grader/objective-score", { method: "POST", body: { submissionId: id, ...objectiveForm } });
      await onSaved?.();
      onClose();
    };
    return h(Modal, { title: "Review answers", onClose },
      h("p", null, `Type: ${s.type}`),
      h("div", { className: "grid cards" },
        h(Field, { label: "Raw Score", type: "number", min: 0, max: 40, step: 1, value: objectiveForm.score, onChange: (v) => setObjectiveForm({ ...objectiveForm, score: Number(v) }) }),
        h(Field, { label: "Band", type: "number", min: 0, max: 9, step: 0.5, value: objectiveForm.estimatedBand, onChange: (v) => setObjectiveForm({ ...objectiveForm, estimatedBand: Number(v) }) }),
        h("div", { className: "field" }, h("label", null, "Status"), h("select", { className: "input", value: objectiveForm.status, onChange: (e) => setObjectiveForm({ ...objectiveForm, status: e.target.value }) }, ["Returned to Student", "Reviewed", "In Review"].map((status) => h("option", { key: status, value: status }, status))))
      ),
      h("h3", { style: { marginTop: 18 } }, "Student Answers"),
      h("div", { className: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["#", "Question", "Student Answer", "Correct Answer", "Result"].map((x) => h("th", { key: x }, x)))),
        h("tbody", null, (s.details || []).map((d) => h("tr", { key: d.questionId },
          h("td", null, d.number),
          h("td", null, d.questionText),
          h("td", null, d.answer || "-"),
          h("td", null, d.correctAnswer || "-"),
          h("td", null, h("span", { className: d.correct ? "correct" : "incorrect" }, d.correct ? "Correct" : "Incorrect"))
        )))
      )),
      h("div", { className: "actions", style: { marginTop: 14 } }, h("button", { type: "button", className: "btn", onClick: saveObjective }, "Save Score"))
    );
  }
  const criteria = s.type === "speaking" ? ["fluencyScore", "lexicalScore", "grammarScore", "pronunciationScore"] : ["taskAchievementScore", "coherenceScore", "lexicalScore", "grammarScore"];
  return h(Modal, { title: "Grade submission", onClose },
    h("p", null, `Type: ${s.type}`),
    s.task1Answer && h("div", null, h("h3", null, "Task 1"), h("p", null, s.task1Answer)),
    s.task2Answer && h("div", null, h("h3", null, "Task 2"), h("p", null, s.task2Answer)),
    s.audioUrl && h("audio", { controls: true, src: s.audioUrl, style: { width: "100%" } }),
    criteria.map((c) => h(Field, { key: c, label: c, type: "number", min: 0, max: 9, step: 0.5, value: form.scores[c] || "", onChange: (v) => setForm({ ...form, scores: { ...form.scores, [c]: Number(v) } }) })),
    h(Field, { label: "Overall Band", type: "number", min: 0, max: 9, step: 0.5, value: form.overallBand, onChange: (v) => setForm({ ...form, overallBand: Number(v) }) }),
    h("textarea", { placeholder: "Feedback", value: form.feedback, onChange: (e) => setForm({ ...form, feedback: e.target.value }) }),
    h("div", { className: "actions" }, h("button", { type: "button", className: "btn secondary", onClick: () => submit(false) }, "Save Draft"), h("button", { type: "button", className: "btn", onClick: () => submit(true) }, "Submit Final Grade"))
  );
}

function Reports() {
  return h("div", { className: "card grid" },
    h("p", null, "Export reports for student accounts, results by class, skill scores, grading status, full mock results, and grader workload."),
    h("div", { className: "actions" },
      h("button", { className: "btn secondary", onClick: () => location.href = "/api/admin/export?type=accounts" }, "Export Student Accounts"),
      h("button", { className: "btn secondary", onClick: () => location.href = "/api/admin/export?type=results" }, "Export Results")
    )
  );
}

function Field({ label, value, onChange, type = "text", required, min, max, step }) {
  const isRequired = required ?? label !== "Email";
  return h("div", { className: "field" }, h("label", null, label), h("input", { className: "input", type, value, min, max, step, onChange: (e) => onChange(e.target.value), required: isRequired }));
}

function Modal({ title, onClose, children }) {
  return h("div", { className: "modal-backdrop" }, h("div", { className: "modal" }, h("div", { className: "actions", style: { justifyContent: "space-between" } }, h("h3", null, title), h("button", { className: "btn small ghost", onClick: onClose }, "Close")), children));
}

function rowsToCsv(rows) {
  const headers = Object.keys(rows[0] || {});
  return [headers.join(","), ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(","))].join("\n");
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
