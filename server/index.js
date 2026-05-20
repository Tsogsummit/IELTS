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
const EXAM_DATE = process.env.EXAM_DATE || "2026-05-20";
const EXAM_TZ_OFFSET = process.env.EXAM_TZ_OFFSET || "+08:00";
const sessions = new Map();

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

function scheduleWindow(startTime, endTime) {
  return {
    startsAt: `${EXAM_DATE}T${startTime}:00${EXAM_TZ_OFFSET}`,
    endsAt: `${EXAM_DATE}T${endTime}:00${EXAM_TZ_OFFSET}`
  };
}

function ensureCollections(db) {
  if (!Array.isArray(db.submissions)) db.submissions = [];
  if (!Array.isArray(db.testAttempts)) db.testAttempts = [];
  if (!Array.isArray(db.graderAssignments)) db.graderAssignments = [];
  if (!Array.isArray(db.writingGrades)) db.writingGrades = [];
  if (!Array.isArray(db.speakingGrades)) db.speakingGrades = [];
  if (!Array.isArray(db.credentialBatches)) db.credentialBatches = [];
  return db;
}

function getActiveAttempt(db, userId, testId) {
  for (let i = db.testAttempts.length - 1; i >= 0; i--) {
    const attempt = db.testAttempts[i];
    if (attempt.userId === userId && attempt.testId === testId && !attempt.submittedAt && !attempt.submissionId) return attempt;
  }
  return null;
}

function latestSubmissionFor(db, userId, testId) {
  for (let i = db.submissions.length - 1; i >= 0; i--) {
    const submission = db.submissions[i];
    if (submission.userId === userId && submission.testId === testId) return submission;
  }
  return null;
}

function publicAttempt(attempt) {
  if (!attempt) return null;
  return {
    id: attempt.id,
    testId: attempt.testId,
    type: attempt.type,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    lastSavedAt: attempt.lastSavedAt,
    submittedAt: attempt.submittedAt || null,
    submissionId: attempt.submissionId || null,
    status: attempt.status || "in_progress",
    answers: attempt.answers || {},
    draft: attempt.draft || {}
  };
}

function activeAttemptSummary(attempt) {
  if (!attempt) return null;
  return {
    id: attempt.id,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    lastSavedAt: attempt.lastSavedAt,
    status: attempt.status || "in_progress",
    secondsRemaining: Math.max(0, Math.ceil((new Date(attempt.expiresAt).getTime() - Date.now()) / 1000))
  };
}

function createAttempt(db, user, test) {
  const createdAt = now();
  const attempt = {
    id: id("attempt"),
    userId: user.id,
    testId: test.id,
    type: test.type,
    startedAt: createdAt,
    expiresAt: new Date(Date.now() + Number(test.duration || 0) * 60 * 1000).toISOString(),
    lastSavedAt: createdAt,
    answers: {},
    draft: {},
    status: "in_progress"
  };
  db.testAttempts.push(attempt);
  return attempt;
}

function timeSpentForAttempt(attempt) {
  const started = new Date(attempt.startedAt).getTime();
  const ended = new Date(attempt.submittedAt || now()).getTime();
  return Math.max(0, Math.round((ended - started) / 1000));
}

function buildSubmissionFromAttempt(test, attempt) {
  const base = {
    id: id("sub"),
    userId: attempt.userId,
    testId: test.id,
    attemptId: attempt.id,
    type: test.type,
    answers: attempt.answers || {},
    timeSpent: timeSpentForAttempt(attempt),
    submittedAt: attempt.submittedAt || now(),
    status: "Pending Review"
  };
  if (["listening", "reading"].includes(test.type)) {
    const result = scoreAnswers(test, attempt.answers || {});
    Object.assign(base, { score: result.score, estimatedBand: result.estimatedBand, details: result.details, status: "Returned to Student" });
  } else if (test.type === "writing") {
    Object.assign(base, {
      score: null,
      estimatedBand: null,
      task1Answer: attempt.draft?.task1 || "",
      task2Answer: attempt.draft?.task2 || "",
      audioUrl: ""
    });
  } else if (test.type === "speaking") {
    Object.assign(base, {
      score: null,
      estimatedBand: null,
      answers: attempt.draft || {},
      audioUrl: attempt.draft?.audioUrl || ""
    });
  } else {
    Object.assign(base, { score: null, estimatedBand: null });
  }
  return base;
}

function finalizeAttempt(db, attempt, reason = "manual_submit") {
  if (!attempt) return null;
  if (attempt.submissionId) return db.submissions.find((s) => s.id === attempt.submissionId) || null;
  const test = db.tests.find((t) => t.id === attempt.testId);
  if (!test) return null;
  attempt.submittedAt = now();
  attempt.lastSavedAt = attempt.submittedAt;
  attempt.status = "submitted";
  attempt.finalizedReason = reason;
  const submission = buildSubmissionFromAttempt(test, attempt);
  attempt.submissionId = submission.id;
  db.submissions.push(submission);
  return submission;
}

function finalizeOverdueAttempts(db) {
  let changed = false;
  const current = Date.now();
  for (const attempt of db.testAttempts) {
    if (attempt.submittedAt || attempt.submissionId) continue;
    const expiresAt = new Date(attempt.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && current >= expiresAt) {
      const submission = finalizeAttempt(db, attempt, "time_expired");
      if (submission) changed = true;
    }
  }
  return changed;
}

function roundIeltsAverage(scores) {
  const avg = scores.reduce((a, b) => a + Number(b || 0), 0) / 4;
  const whole = Math.floor(avg);
  const dec = avg - whole;
  if (dec < 0.25) return whole;
  if (dec < 0.75) return whole + 0.5;
  return whole + 1;
}

function readingPassageText() {
  return `READING PASSAGE 1

Frozen Food
A US perspective on the development of the frozen food industry

At some point in history, humans discovered that ice preserved food. There is evidence that winter ice was stored to preserve food in the summer as far back as 10,000 years ago. Two thousand years ago, the inhabitants of South America's Andean mountains had a unique means of conserving potatoes for later consumption. They froze them overnight, then trampled them to squeeze out the moisture, then dried them in the sun. This preserved their nutritional value - if not their aesthetic appeal.

Natural ice remained the main form of refrigeration until late in the 19th century. In the early 1800s, ship owners from Boston, USA, had enormous blocks of Arctic ice towed all over the Atlantic for the purpose of food preservation. In 1851, railroads first began putting blocks of ice in insulated rail cars to send butter from Ogdensburg, New York, to Boston.

Finally, in 1870, Australian inventors found a way to make 'mechanical ice'. They used a compressor to force a gas - ammonia at first and later Freon - through a condenser. The compressed gas gave up some of its heat as it moved through the condenser. Then the gas was released quickly into a low-pressure evaporator coil where it became liquid and cold. Air was blown over the evaporator coil and then this cooled air passed into an insulated compartment, lowering its temperature to freezing point.

Initially, this process was invented to keep Australian beer cool even in hot weather. But Australian cattlemen were quick to realize that, if they could put this new invention on a ship, they could export meat across the oceans. In 1880, a shipment of Australian beef and mutton was sent, frozen, to England. While the food frozen this way was still palatable, there was some deterioration. During the freezing process, crystals formed within the cells of the food, and when the ice expanded and the cells burst, this spoilt the flavor and texture of the food.

The modern frozen food industry began with the indigenous Inuit people of Canada. In 1912, a biology student in Massachusetts, USA, named Clarence Birdseye, ran out of money and went to Labrador in Canada to trap and trade furs. While he was there, he became fascinated with how the Inuit would quickly freeze fish in the Arctic air. The fish looked and tasted fresh even months later.

Birdseye returned to the USA in 1917 and began developing mechanical freezers capable of quick-freezing food. Birdseye methodically kept inventing better freezers and gradually built a business selling frozen fish from Gloucester, Massachusetts. In 1929, his business was sold and became General Foods, but he stayed with the company as director of research, and his division continued to innovate.

Birdseye was responsible for several key innovations that made the frozen food industry possible. He developed quick-freezing techniques that reduced the damage that crystals caused, as well as the technique of freezing the product in the package it was to be sold in. He also introduced the use of cellophane, the first transparent material for food packaging, which allowed consumers to see the quality of the product. Birdseye products also came in convenient size packages that could be prepared with a minimum of effort.

But there were still obstacles. In the 1930s, few grocery stores could afford to buy freezers for a market that was not established yet. So, Birdseye leased inexpensive freezer cases to them. He also leased insulated railroad cars so that he could ship his products nationwide. However, few consumers had freezers large enough or efficient enough to take advantage of the products.

Sales increased in the early 1940s, when World War II gave a boost to the frozen food industry because tin was being used for munitions. Canned foods were rationed to save tin for the war effort, while frozen foods were abundant and cheap. Finally, by the 1950s, refrigerator technology had developed far enough to make these appliances affordable for the average family. By 1953, 33 million US families owned a refrigerator, and manufacturers were gradually increasing the size of the freezer compartments in them.

1950s families were also looking for convenience at mealtimes, so the moment was right for the arrival of the TV Dinner. Swanson Foods was a large, nationally recognized producer of canned and frozen poultry. In 1954, the company adapted some of Birdseye's freezing techniques, and with the help of a clever name and a huge advertising budget, it launched the first TV Dinner. This consisted of frozen turkey, potatoes and vegetables served in the same segmented aluminum tray that was used by airlines. The product was an instant success. Within a year, Swanson had sold 13 million TV dinners. American consumers could not resist the combination of a trusted brand name, a single-serving package and the convenience of a meal that could be ready after only 25 minutes in a hot oven. By 1959, Americans were spending $2.7 billion annually on frozen foods, and half a billion of that was spent on ready-prepared meals such as the TV Dinner.

Today, the US frozen food industry has a turnover of over $67 billion annually, with $26.6 billion of that sold to consumers for home consumption. The remaining $40 billion in frozen food sales come through restaurants, cafeterias, hospitals and schools, and that represents a third of the total food service sales.

READING PASSAGE 2

Can the planet's coral reefs be saved?

A Conservationists have put the final touches to a giant artificial reef they have been assembling at the world-renowned Zoological Society of London (London Zoo). Samples of the planet's most spectacular corals - vivid green branching coral, yellow scroll, blue ridge and many more species have been added to the giant tank along with fish that thrive in their presence: blue tang, clownfish and many others. The reef is in the zoo's new gallery, Tiny Giants, which is dedicated to the minuscule invertebrate creatures that sustain life across the planet. The coral reef tank and its seven-metre-wide window form the core of the exhibition.

'Coral reefs are the most diverse ecosystems on Earth and we want to show people how wonderful they are,' said Paul Pearce-Kelly, senior curator of invertebrates and fish at the Zoological Society of London. 'However, we also want to highlight the research and conservation efforts that are now being carried out to try to save them from the threat of global warming.' They want people to see what is being done to try to save these wonders.

B Corals are composed of tiny animals, known as polyps, with tentacles for capturing small marine creatures in the sea water. These polyps are transparent but get their brilliant tones of pink, orange, blue, green, etc. from algae that live within them, which in turn get protection, while their photosynthesising of the sun's rays provides nutrients for the polyps. This comfortable symbiotic relationship has led to the growth of coral reefs that cover 0.1% of the planet's ocean bed while providing homes for more than 25% of marine species, including fish, molluscs, sponges and shellfish.

C As a result, coral reefs are often described as the 'rainforests of the sea', though the comparison is dismissed by some naturalists, including David Attenborough. 'People say you cannot beat the rainforest,' Attenborough has stated. 'But that is simply not true. You go there and the first thing you think is: where are the birds? Where are the animals? They are hiding in the trees, of course. No, if you want beauty and wildlife, you want a coral reef. Put on a mask and stick your head under the water. The sight is mind-blowing.'

D Unfortunately, these majestic sights are now under very serious threat, with the most immediate problem coming in the form of thermal stress. Rising ocean temperatures are triggering bleaching events that strip reefs of their colour and eventually kill them. And that is just the start. Other menaces include ocean acidification, sea level increase, pollution by humans, deoxygenation and ocean current changes, while the climate crisis is also increasing habitat destruction. As a result, vast areas including massive chunks of Australia's Great Barrier Reef have already been destroyed, and scientists advise that more than 90% of reefs could be lost by 2050 unless urgent action is taken to tackle global heating and greenhouse gas emissions.

Pearce-Kelly says that coral reefs have to survive really harsh conditions, wave erosion and other factors. And 'when things start to go wrong in the oceans, then corals will be the first to react. And that is exactly what we are seeing now. Coral reefs are dying and they are telling us that all is not well with our planet.'

E However, scientists are trying to pinpoint hardy types of coral that could survive our overheated oceans, and some of this research will be carried out at London Zoo. 'Behind our coral reef tank we have built laboratories where scientists will be studying coral species,' said Pearce-Kelly. One aim will be to carry out research on species to find those that can survive best in warm, acidic waters. Another will be to try to increase coral breeding rates. 'Coral spawn just once a year,' he added. 'However, aquarium-based research has enabled some corals to spawn artificially, which can assist coral reef restoration efforts. And if this can be extended for all species, we could consider the launching of coral-spawning programmes several times a year. That would be a big help in restoring blighted reefs.'

F Research in these fields is being conducted in laboratories around the world, with the London Zoo centre linked to this global network. Studies carried out in one centre can then be tested in others. The resulting young coral can then be displayed in the tank in Tiny Giants. 'The crucial point is that the progress we make in making coral better able to survive in a warming world can be shown to the public and encourage them to believe that we can do something to save the planet's reefs,' said Pearce-Kelly. 'Saving our coral reefs is now a critically important ecological goal.'

READING PASSAGE 3

Robots and us

Three leaders in their fields answer questions about our relationships with robots.

When asked 'Should robots be used to colonise other planets?', cosmology and astrophysics Professor Martin Rees said he believed the solar system would be mapped by robotic craft by the end of the century. 'The next step would be mining of asteroids, enabling fabrication of large structures in space without having to bring all the raw materials from Earth... I think this is more realistic and benign than the terraforming of planets.' He maintains that colonised planets 'should be preserved with a status that is analogous to Antarctica here on Earth.'

On the question of using robots to colonise other planets and exploit mineral resources, engineering Professor Daniel Wolpert replied, 'I do not see a pressing need to colonise other planets unless we can bring these resources back to Earth. The vast majority of Earth is currently inaccessible to us. Using robots to gather resources nearer to home would seem to be a better use of our robotic tools.'

Meanwhile, for anthropology Professor Kathleen Richardson, the idea of 'colonisation' of other planets seemed morally dubious: 'I think whether we do something on Earth or on Mars we should always do it in the spirit of a genuine interest in the Other, not to impose a particular model, but to meet the Other.'

In response to the second question, 'How soon will machine intelligence outstrip human intelligence?', Rees mentions robots that are advanced enough to beat humans at chess, but then goes on to say, 'Robots are still limited in their ability to sense their environment: they cannot yet recognise and move the pieces on a real chessboard as cleverly as a child can. Later this century, however, their more advanced successors may relate to their surroundings, and to people, as adeptly as we do. Moral questions then arise. Should we feel guilty about exploiting sophisticated robots? Should we fret if they are underemployed, frustrated, or bored?'

Wolpert's response to the question about machine intelligence outstripping human intelligence was this: 'In a limited sense it already has. Machines can already navigate, remember and search for items with an ability that far outstrips humans. However, there is no machine that can identify visual objects or speech with the reliability and flexibility of humans. Expecting a machine close to the creative intelligence of a human within the next 50 years would be highly ambitious.'

Richardson believes that our fear of machines becoming too advanced has more to do with human nature than anything intrinsic to the machines themselves. In her view, it stems from humans' tendency to personify inanimate objects: we create machines based on representations of ourselves, imagine that machines think and behave as we do, and therefore see them as an autonomous threat. 'One of the consequences of thinking that the problem lies with machines is that we tend to imagine they are greater and more powerful than they really are and subsequently they become so.'

This led on to the third question, 'Should we be scared by advances in artificial intelligence?' To this question, Rees replied, 'Those who should be worried are the futurologists who believe in the so-called singularity. And another worry is that we are increasingly dependent on computer networks, and that these could behave like a single brain with a mind of its own, and with goals that may be contrary to human welfare. I think we should ensure that robots remain as no more than idiot savants lacking the capacity to outwit us, even though they may greatly surpass us in the ability to calculate and process information.'

Wolpert's response was to say that we have already seen the damaging effects of artificial intelligence in the form of computer viruses. 'But in this case,' he says, 'the real intelligence is the malicious designer. Critically, the benefits of computers outweigh the damage that computer viruses cause. Similarly, while there may be misuses of robotics in the near future, the benefits that they will bring are likely to outweigh these negative aspects.'

Richardson's response to this question was this: 'We need to ask why fears of artificial intelligence and robots persist; none have in fact risen up and challenged human supremacy.' She believes that as robots have never shown themselves to be a threat to humans, it seems unlikely that they ever will. In fact, she went on, 'Not all fear robots; many people welcome machine intelligence.'

In answer to the fourth question, 'What can science fiction tell us about robotics?', Rees replied, 'I sometimes advise students that it is better to read first-rate science fiction than second-rate science - more stimulating, and perhaps no more likely to be wrong.'

As his response, Wolpert commented, 'Science fiction has often been remarkable at predicting the future. Science fiction has painted a vivid spectrum of possible futures, from cute and helpful robots to dystopian robotic societies. Interestingly, almost no science fiction envisages a future without robots.'

Finally, on the question of science fiction, Richardson pointed out that in modern society, people tend to think there is reality on the one hand, and fiction and fantasy on the other. She then explained that the division did not always exist, and that scientists and technologists made this separation because they wanted to carve out the sphere of their work. 'But the divide is not so clear cut, and that is why the worlds seem to collide at times,' she said. 'In some cases, we need to bring these different understandings together to get a whole perspective. Perhaps then, we will not be so frightened that something we create as a copy of ourselves will be a threat to us.'`;
}

function readingQuestions(readingId) {
  const headings = ["i. Tried and tested solutions", "ii. cooperation beneath the waves", "iii. working to lessen the problems", "iv. disagreement about the accuracy of a certain phrase", "v. two clear educational goals", "vi. promoting hope", "vii. A warning of further trouble ahead"];
  const causes = ["A. a rising number of extreme storms", "B. the removal of too many fish from the sea", "C. the contamination of the sea from waste", "D. increased disease among marine species", "E. alterations in the usual flow of water in the seas"];
  const zoo = ["A. They are hoping to expand the numbers of different corals being bred in laboratories", "B. They want to identify corals that can cope well with the changed sea conditions", "C. They are looking at ways of creating artificial reefs that corals could grow on", "D. They are trying out methods that would speed up reproduction in some corals", "E. They are investigating materials that might protect reefs from higher temperatures"];
  const experts = ["A. Martin Rees", "B. Daniel Wolpert", "C. Kathleen Richardson"];
  const endings = ["A. robots to explore outer space", "B. advances made in machine intelligence so far", "C. changes made to other planets for our own benefit", "D. the harm already done by artificial intelligence"];
  return [
    q(readingId, 1, 1, "Passage 1: People conserved the nutritional value of ____ using a method of freezing then drying.", "blank", [], "potatoes", "The Andean method preserved potatoes."),
    q(readingId, 1, 2, "Passage 1: ____ was kept cool by ice during transportation in specially adapted trains.", "blank", [], "butter", "Butter was sent in insulated rail cars."),
    q(readingId, 1, 3, "Passage 1: Two kinds of ____ were the first frozen food shipped to England.", "blank", [], "meat", "Beef and mutton are two kinds of meat."),
    q(readingId, 1, 4, "Passage 1: Quick-freezing methods meant ____ did not spoil the food.", "blank", [], "crystals", "Quick freezing reduced damage caused by crystals."),
    q(readingId, 1, 5, "Passage 1: Birdseye packaged products with ____ so the product was visible.", "blank", [], "cellophane", "Cellophane was transparent packaging."),
    q(readingId, 1, 6, "Passage 1: Frozen food became popular because of a shortage of ____.", "blank", [], "tin", "Tin was needed for munitions."),
    q(readingId, 1, 7, "Passage 1: In the 1950s, a large number of homes now had a ____.", "blank", [], "refrigerator", "Many US families owned a refrigerator."),
    q(readingId, 1, 8, "Passage 1: The ice transportation business made some Boston ship owners very wealthy in the early 1800s.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "NOT GIVEN", "The passage does not say whether they became wealthy."),
    q(readingId, 1, 9, "Passage 1: A disadvantage of the freezing process invented in Australia was that it affected the taste of food.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "TRUE", "The passage says the process spoilt flavor and texture."),
    q(readingId, 1, 10, "Passage 1: Clarence Birdseye travelled to Labrador in order to learn how the Inuit people froze fish.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "FALSE", "He went to trap and trade furs."),
    q(readingId, 1, 11, "Passage 1: Swanson Foods invested a great deal of money in the promotion of the TV Dinner.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "TRUE", "The passage mentions a huge advertising budget."),
    q(readingId, 1, 12, "Passage 1: Swanson Foods developed a new style of container for the launch of the TV Dinner.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "FALSE", "The tray was the same type used by airlines."),
    q(readingId, 1, 13, "Passage 1: The US frozen food industry is currently the largest in the world.", "tfng", ["TRUE", "FALSE", "NOT GIVEN"], "NOT GIVEN", "The passage gives turnover figures but no global comparison."),
    q(readingId, 2, 14, "Passage 2: Choose the correct heading for Section A.", "mcq", headings, "v. two clear educational goals", "The section describes showing reef beauty and highlighting conservation."),
    q(readingId, 2, 15, "Passage 2: Choose the correct heading for Section B.", "mcq", headings, "ii. cooperation beneath the waves", "The section explains the symbiotic relationship between corals and algae."),
    q(readingId, 2, 16, "Passage 2: Choose the correct heading for Section C.", "mcq", headings, "iv. disagreement about the accuracy of a certain phrase", "The section discusses the disputed phrase rainforests of the sea."),
    q(readingId, 2, 17, "Passage 2: Choose the correct heading for Section D.", "mcq", headings, "vii. A warning of further trouble ahead", "The section warns of reef loss by 2050."),
    q(readingId, 2, 18, "Passage 2: Choose the correct heading for Section E.", "mcq", headings, "iii. working to lessen the problems", "The section describes research to help reefs survive."),
    q(readingId, 2, 19, "Passage 2: Choose the correct heading for Section F.", "mcq", headings, "vi. promoting hope", "The section says progress can encourage public hope."),
    q(readingId, 2, 20, "Passage 2: Which TWO causes of damage to coral reefs are mentioned? Write both letters, e.g. C, E.", "blank", causes, "C, E", "Pollution by humans and ocean current changes are mentioned."),
    q(readingId, 2, 21, "Passage 2: Which TWO causes of damage to coral reefs are mentioned? Write the same two letters as Question 20.", "blank", causes, "C, E", "This pair completes Questions 20 and 21."),
    q(readingId, 2, 22, "Passage 2: Which TWO statements are true of the researchers at London Zoo? Write both letters, e.g. B, D.", "blank", zoo, "B, D", "They want to identify hardy corals and increase breeding rates."),
    q(readingId, 2, 23, "Passage 2: Which TWO statements are true of the researchers at London Zoo? Write the same two letters as Question 22.", "blank", zoo, "B, D", "This pair completes Questions 22 and 23."),
    q(readingId, 2, 24, "Passage 2: Corals have a number of ____ which they use to collect their food.", "blank", [], "tentacles", "Polyps have tentacles for capturing food."),
    q(readingId, 2, 25, "Passage 2: Algae gain ____ from being inside the coral.", "blank", [], "protection", "The algae get protection from the coral."),
    q(readingId, 2, 26, "Passage 2: Increases in the warmth of the sea water can remove the ____ from coral.", "blank", [], "colour", "Bleaching strips reefs of their colour."),
    q(readingId, 3, 27, "Passage 3: For our own safety, humans will need to restrict the abilities of robots.", "mcq", experts, "A. Martin Rees", "Rees says robots should lack the capacity to outwit us."),
    q(readingId, 3, 28, "Passage 3: The risk of robots harming us is less serious than humans believe it to be.", "mcq", experts, "C. Kathleen Richardson", "Richardson says robots have not shown themselves to be a threat."),
    q(readingId, 3, 29, "Passage 3: It will take many decades for robot intelligence to be as imaginative as human intelligence.", "mcq", experts, "B. Daniel Wolpert", "Wolpert says human-level creative intelligence within 50 years is highly ambitious."),
    q(readingId, 3, 30, "Passage 3: We may have to start considering whether we are treating robots fairly.", "mcq", experts, "A. Martin Rees", "Rees raises moral questions about exploiting sophisticated robots."),
    q(readingId, 3, 31, "Passage 3: Robots are probably of more help to us on Earth than in space.", "mcq", experts, "B. Daniel Wolpert", "Wolpert says gathering resources nearer to home is a better use."),
    q(readingId, 3, 32, "Passage 3: High-quality science fiction may be just as accurate as mediocre scientists.", "mcq", experts, "A. Martin Rees", "Rees recommends first-rate science fiction over second-rate science."),
    q(readingId, 3, 33, "Passage 3: There are those who look forward to robots developing greater intelligence.", "mcq", experts, "C. Kathleen Richardson", "Richardson says many people welcome machine intelligence."),
    q(readingId, 3, 34, "Passage 3: Richardson and Rees express similar views regarding the ethical aspect of...", "mcq", endings, "C. changes made to other planets for our own benefit", "Both raise ethical concerns about changing or imposing on other planets."),
    q(readingId, 3, 35, "Passage 3: Rees and Wolpert share an opinion about the extent of...", "mcq", endings, "B. advances made in machine intelligence so far", "Both identify current limits of machine intelligence."),
    q(readingId, 3, 36, "Passage 3: Wolpert disagrees with Richardson on the question of...", "mcq", endings, "D. the harm already done by artificial intelligence", "Wolpert cites computer viruses; Richardson says robots have not challenged humans."),
    q(readingId, 3, 37, "Passage 3: What point does Richardson make about fear of machines?", "mcq", ["A. It has grown alongside the development of ever more advanced robots", "B. It is the result of our inclination to attribute human characteristics to non-human entities", "C. It has its origins in basic misunderstandings about how inanimate objects function", "D. It demonstrates a key difference between human intelligence and machine intelligence"], "B. It is the result of our inclination to attribute human characteristics to non-human entities", "Richardson refers to personifying inanimate objects."),
    q(readingId, 3, 38, "Passage 3: What potential advance does Rees see as a cause for concern?", "mcq", ["A. robots outnumbering people", "B. robots having abilities which humans do not", "C. artificial intelligence developing independent thought", "D. artificial intelligence taking over every aspect of our lives"], "C. artificial intelligence developing independent thought", "Rees worries about a network behaving like a brain with its own goals."),
    q(readingId, 3, 39, "Passage 3: What does Wolpert emphasise in his response to the question about science fiction?", "mcq", ["A. how science fiction influences our attitudes to robots", "B. how fundamental robots are to the science fiction genre", "C. how the image of robots in science fiction has changed over time", "D. how reactions to similar portrayals of robots in science fiction may vary"], "B. how fundamental robots are to the science fiction genre", "Wolpert says almost no science fiction imagines a future without robots."),
    q(readingId, 3, 40, "Passage 3: What is Richardson doing in her comment about reality and fantasy?", "mcq", ["A. warning people not to confuse one with the other", "B. outlining ways in which one has impacted on the other", "C. recommending a change of approach in how people view them", "D. explaining why scientists have a different perspective on them from other people"], "C. recommending a change of approach in how people view them", "Richardson says different understandings need to be brought together.")
  ];
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
      audioUrl: "https://practicepteonline.com/wp-content/uploads/audio/203_we.mp3?_=1",
      createdAt: now(),
      sections: [
        { title: "Part 1: Furniture Rental Companies", instructions: "Complete the notes. Write ONE WORD AND/OR A NUMBER for each answer." },
        { title: "Part 2: Bidcaster Community Archaeology Project", instructions: "Choose the correct letter, A, B, or C. Use the Bidcaster Archaeological Dig map for the map-label questions.", image: "/assets/bidcaster.png" },
        { title: "Part 3: Project on Theatre Programmes", instructions: "Choose the correct letter, A, B, or C." },
        { title: "Part 4: Inclusive Design", instructions: "Complete the notes. Write ONE WORD ONLY for each answer." }
      ],
      questions: [
        q(listeningId, 1, 1, "Part 1: Prices range from $105 to ____ per month.", "blank", [], "239", "Furniture rental price range."),
        q(listeningId, 1, 2, "Part 1: The furniture is very ____.", "blank", [], "modern", "Furniture description."),
        q(listeningId, 1, 3, "Part 1: Free ____ with every living room set.", "blank", [], "lamp", "Special offer item."),
        q(listeningId, 1, 4, "Part 1: Company name: ____ and Oliver.", "blank", [], "Aaron", "Company name."),
        q(listeningId, 1, 5, "Part 1: 12% monthly fee for ____.", "blank", [], "damage", "Monthly fee covers damage."),
        q(listeningId, 1, 6, "Part 1: Cheapest prices for renting furniture and ____ items.", "blank", [], "electronic", "Item category."),
        q(listeningId, 1, 7, "Part 1: Must have own ____.", "blank", [], "insurance", "Customer requirement."),
        q(listeningId, 1, 8, "Part 1: ____ Rentals.", "blank", [], "Space", "Company name."),
        q(listeningId, 1, 9, "Part 1: See the ____ for the most up-to-date prices.", "blank", [], "app", "Where prices are updated."),
        q(listeningId, 1, 10, "Part 1: ____ are allowed within 7 days of delivery.", "blank", [], "exchanges", "Delivery policy."),
        q(listeningId, 2, 11, "Part 2: Who was responsible for starting the community project?", "mcq", ["A. The castle owners", "B. A national charity", "C. The local council"], "B. A national charity", "Project origin."),
        q(listeningId, 2, 12, "Part 2: How was the gold coin found?", "mcq", ["A. Heavy rain had removed some of the soil", "B. The ground was dug up by wild rabbits", "C. A person with a metal detector searched the area"], "A. Heavy rain had removed some of the soil", "Discovery method."),
        q(listeningId, 2, 13, "Part 2: What led archaeologists to believe there was an ancient village on this site?", "mcq", ["A. The lucky discovery of old records", "B. The bases of several structures visible in the grass", "C. The unusual stones found near the castle"], "A. The lucky discovery of old records", "Evidence for the village."),
        q(listeningId, 2, 14, "Part 2: What are the team still hoping to find?", "mcq", ["A. Everyday pottery", "B. Animal bones", "C. Pieces of jewellery"], "C. Pieces of jewellery", "Remaining target find."),
        q(listeningId, 2, 15, "Part 2: What was found on the other side of the river to the castle?", "mcq", ["A. The remains of a large palace", "B. The outline of fields", "C. A number of small huts"], "B. The outline of fields", "Find across the river."),
        q(listeningId, 2, 16, "Part 2: What do the team plan to do after work ends this summer?", "mcq", ["A. Prepare a display for a museum", "B. Take part in a television programme", "C. Start to organize school visits"], "C. Start to organize school visits", "Next planned activity."),
        q(listeningId, 2, 17, "Part 2 map: Bridge foundations. Write the correct letter A-G.", "blank", [], "B", "Map label."),
        q(listeningId, 2, 18, "Part 2 map: Rubbish pit. Write the correct letter A-G.", "blank", [], "A", "Map label."),
        q(listeningId, 2, 19, "Part 2 map: Meeting hall. Write the correct letter A-G.", "blank", [], "G", "Map label."),
        q(listeningId, 2, 20, "Part 2 map: Fish pond. Write the correct letter A-G.", "blank", [], "E", "Map label."),
        q(listeningId, 3, 21, "Part 3: Finn was pleased to discover that their topic...", "mcq", ["A. was not familiar to their module leader", "B. had not been chosen by other students", "C. did not prove to be difficult to research"], "B. had not been chosen by other students", "Theatre programmes project."),
        q(listeningId, 3, 22, "Part 3: Maya says a mistaken belief about theatre programmes is that...", "mcq", ["A. theatres pay companies to produce them", "B. few theatre-goers buy them nowadays", "C. they contain far more adverts than previously"], "A. theatres pay companies to produce them", "Common misconception."),
        q(listeningId, 3, 23, "Part 3: Finn was surprised that, in early British theatre, programmes...", "mcq", ["A. were difficult for audiences to obtain", "B. were given out free of charge", "C. were seen as a kind of contract"], "C. were seen as a kind of contract", "Historical role."),
        q(listeningId, 3, 24, "Part 3: Maya feels their project should explain why companies of actors...", "mcq", ["A. promoted their own plays", "B. performed plays outdoors", "C. had to tour with their plays"], "A. promoted their own plays", "Project explanation."),
        q(listeningId, 3, 25, "Part 3: Compared to nineteenth-century programmes, eighteenth-century programmes were...", "mcq", ["A. more original", "B. more colourful", "C. more informative"], "C. more informative", "Comparison."),
        q(listeningId, 3, 26, "Part 3: Maya does not fully understand why, in the twentieth century...", "mcq", ["A. very few theatre programmes were printed in the USA", "B. British theatre programmes failed to develop for so long", "C. theatre programmes in Britain copied fashions from the USA"], "B. British theatre programmes failed to develop for so long", "Twentieth-century issue."),
        q(listeningId, 3, 27, "Part 3 shows: Ruy Blas. Choose the comment A-F.", "mcq", ["A. Its origin is somewhat controversial", "B. It is historically significant for a country", "C. It was effective at attracting audiences", "D. It is included in a recent project", "E. It contains insights into the show", "F. It resembles an artwork"], "F. It resembles an artwork", "Programme comment."),
        q(listeningId, 3, 28, "Part 3 shows: Man of La Mancha. Choose the comment A-F.", "mcq", ["A. Its origin is somewhat controversial", "B. It is historically significant for a country", "C. It was effective at attracting audiences", "D. It is included in a recent project", "E. It contains insights into the show", "F. It resembles an artwork"], "E. It contains insights into the show", "Programme comment."),
        q(listeningId, 3, 29, "Part 3 shows: The Tragedy of Jane Shore. Choose the comment A-F.", "mcq", ["A. Its origin is somewhat controversial", "B. It is historically significant for a country", "C. It was effective at attracting audiences", "D. It is included in a recent project", "E. It contains insights into the show", "F. It resembles an artwork"], "B. It is historically significant for a country", "Programme comment."),
        q(listeningId, 3, 30, "Part 3 shows: The Sailors' Festival. Choose the comment A-F.", "mcq", ["A. Its origin is somewhat controversial", "B. It is historically significant for a country", "C. It was effective at attracting audiences", "D. It is included in a recent project", "E. It contains insights into the show", "F. It resembles an artwork"], "D. It is included in a recent project", "Programme comment."),
        q(listeningId, 4, 31, "Part 4: Products can be accessed without the need for any ____.", "blank", [], "adaptation", "Definition of inclusive design."),
        q(listeningId, 4, 32, "Part 4: Universal design includes catering for people with ____ problems.", "blank", [], "cognitive", "Universal design scope."),
        q(listeningId, 4, 33, "Part 4: ____ which are adjustable, avoiding back or neck problems.", "blank", [], "desks", "Adjustable workplace item."),
        q(listeningId, 4, 34, "Part 4: ____ in public toilets which are easier to use.", "blank", [], "taps", "Public toilet design."),
        q(listeningId, 4, 35, "Part 4: Designers avoid using ____ in interfaces.", "blank", [], "blue", "Interface colour."),
        q(listeningId, 4, 36, "Part 4: People can make commands using a mouse, keyboard or their ____.", "blank", [], "voice", "Input method."),
        q(listeningId, 4, 37, "Part 4: Seat belts are especially problematic for ____ women.", "blank", [], "pregnant", "Safety concern."),
        q(listeningId, 4, 38, "Part 4: PPE jackets are often unsuitable because of the size of women's ____.", "blank", [], "shoulders", "PPE fit issue."),
        q(listeningId, 4, 39, "Part 4: PPE for female ____ officers dealing with emergencies is the worst.", "blank", [], "police", "Emergency service role."),
        q(listeningId, 4, 40, "Part 4: The ____ in offices is often too low for women.", "blank", [], "temperature", "Workplace comfort issue.")
      ]
    },
    {
      id: readingId,
      title: "IELTS Reading Mock 1",
      type: "reading",
      duration: 60,
      ...scheduleWindow("15:00", "16:00"),
      passageTitle: "IELTS Reading Mock 1",
      passage: readingPassageText(),
      createdAt: now(),
      questions: readingQuestions(readingId)
    },
    {
      id: writingId,
      title: "IELTS Writing Mock 1",
      type: "writing",
      duration: 60,
      ...scheduleWindow("16:10", "17:10"),
      task1: "The line graph shows the percentage of people who used five different communication methods between 1998 and 2008. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.",
      task1Image: "/assets/graph.png",
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
    staff("Default Grader", "grader", "Grader1234", "grader"),
    staff("Teacher Test User", "teacher_test", "Teacher1234", "grader")
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
    testAttempts: [],
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
  return ensureCollections(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
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

function answersMatch(answer, expected) {
  const cleanAnswer = String(answer || "").trim().replace(/\s+/g, " ");
  const cleanExpected = String(expected || "").trim().replace(/\s+/g, " ");
  if (cleanExpected.includes(",")) {
    const tokenize = (value) => String(value || "").toLowerCase().match(/[a-z0-9]+/g)?.sort().join("|") || "";
    return tokenize(cleanAnswer) === tokenize(cleanExpected);
  }
  return cleanAnswer.localeCompare(cleanExpected, undefined, { sensitivity: "accent" }) === 0;
}

function scoreAnswers(test, answers) {
  let score = 0;
  const details = test.questions.map((question) => {
    const answer = String(answers[question.id] || "").trim();
    const expected = String(question.correctAnswer || "").trim();
    const correct = answersMatch(answer, expected);
    if (correct) score++;
    return { questionId: question.id, number: question.number, answer, correctAnswer: expected, correct, explanation: question.explanation, questionText: question.questionText };
  });
  return { score, estimatedBand: bandFromRaw(score), details };
}

async function api(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathParts = url.pathname.split("/").filter(Boolean);

  if (finalizeOverdueAttempts(db)) writeDb(db);

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await parseBody(req);
    const user = db.users.find((u) => u.username === body.username && u.isActive);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
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
    return send(res, 200, {
      tests: db.tests.map(({ questions, ...test }) => ({
        ...test,
        questionCount: questions.length,
        scheduleStatus: scheduledStatus(test),
        activeAttempt: user.role === "student" ? activeAttemptSummary(getActiveAttempt(db, user.id, test.id)) : null,
        hasSubmitted: user.role === "student" ? Boolean(latestSubmissionFor(db, user.id, test.id)) : false
      }))
    });
  }

  if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "tests" && pathParts.length === 3) {
    const user = requireRole(req, res, db, ["super_admin", "admin", "student"]);
    if (!user) return;
    const test = db.tests.find((t) => t.id === pathParts[2]);
    if (!test) return send(res, 404, { error: "Test not found" });
    const status = scheduledStatus(test);
    let attempt = user.role === "student" ? getActiveAttempt(db, user.id, test.id) : null;
    const previousSubmission = user.role === "student" ? latestSubmissionFor(db, user.id, test.id) : null;
    const attemptAvailable = attempt && new Date(attempt.expiresAt).getTime() > Date.now();
    if (user.role === "student" && previousSubmission && !attemptAvailable) {
      return send(res, 403, { error: "You have already submitted this test", submissionId: previousSubmission.id });
    }
    if (user.role === "student" && !attemptAvailable && !canBypassSchedule(user) && status.scheduled && !status.available) {
      return send(res, 403, { error: status.notStarted ? "This test has not started yet" : "This test has ended", scheduleStatus: status });
    }
    if (user.role === "student" && !attemptAvailable) {
      attempt = createAttempt(db, user, test);
      writeDb(db);
    }
    const sanitized = { ...test, questions: test.questions.map(({ correctAnswer, explanation, ...safe }) => safe) };
    return send(res, 200, { test: sanitized, attempt: publicAttempt(attempt) });
  }

  if (method === "POST" && pathParts[0] === "api" && pathParts[1] === "tests" && pathParts[3] === "progress") {
    const user = requireRole(req, res, db, ["student", "super_admin", "admin"]);
    if (!user) return;
    const test = db.tests.find((t) => t.id === pathParts[2]);
    if (!test) return send(res, 404, { error: "Test not found" });
    const previousSubmission = latestSubmissionFor(db, user.id, test.id);
    if (previousSubmission) return send(res, 403, { error: "You have already submitted this test", submissionId: previousSubmission.id });
    let attempt = getActiveAttempt(db, user.id, test.id);
    if (!attempt) attempt = createAttempt(db, user, test);
    if (Date.now() >= new Date(attempt.expiresAt).getTime()) {
      const submission = finalizeAttempt(db, attempt, "time_expired");
      writeDb(db);
      return send(res, 200, { expired: true, submission });
    }
    const body = await parseBody(req);
    attempt.answers = body.answers && typeof body.answers === "object" ? body.answers : attempt.answers || {};
    attempt.draft = body.draft && typeof body.draft === "object" ? body.draft : attempt.draft || {};
    attempt.lastSavedAt = now();
    writeDb(db);
    return send(res, 200, { ok: true, attempt: publicAttempt(attempt) });
  }

  if (method === "POST" && pathParts[0] === "api" && pathParts[1] === "tests" && pathParts[3] === "submit") {
    const user = requireRole(req, res, db, ["student", "super_admin", "admin"]);
    if (!user) return;
    const test = db.tests.find((t) => t.id === pathParts[2]);
    if (!test) return send(res, 404, { error: "Test not found" });
    const previousSubmission = latestSubmissionFor(db, user.id, test.id);
    if (previousSubmission) return send(res, 403, { error: "You have already submitted this test", submissionId: previousSubmission.id });
    let attempt = getActiveAttempt(db, user.id, test.id);
    if (!attempt) attempt = createAttempt(db, user, test);
    const body = await parseBody(req);
    if (body.answers && typeof body.answers === "object") attempt.answers = body.answers;
    if (body.draft && typeof body.draft === "object") attempt.draft = body.draft;
    attempt.lastSavedAt = now();
    const reason = Date.now() >= new Date(attempt.expiresAt).getTime() ? "time_expired" : "manual_submit";
    const submission = finalizeAttempt(db, attempt, reason);
    writeDb(db);
    return send(res, 201, { submission });
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
