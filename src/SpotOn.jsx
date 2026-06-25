import { useState, useEffect, useRef, useCallback } from "react";
import { QUESTION_POOL } from "./questions.js";

// ---------- CONTENT ----------
// The daily board draws 15 questions from QUESTION_POOL using the date seed,
// then splits them into 3 boards of 5. A separate "cycle" index walks the
// whole pool before any question repeats, so a 300-question pool gives ~20
// days with no repeat. Everyone on a given day gets the identical selection.
const BOARDS_PER_GAME = 3;
const Q_PER_BOARD = 5;
const Q_PER_GAME = BOARDS_PER_GAME * Q_PER_BOARD; // 15

function pickDailySets(dateKey, rng) {
  const pool = QUESTION_POOL;
  const cyclesPerPool = Math.floor(pool.length / Q_PER_GAME) || 1;
  // which "page" of the shuffled pool this date lands on
  const dayIndex = Math.max(0, dailyNumber(dateKey) - 1);
  const page = dayIndex % cyclesPerPool;
  // a stable shuffle of the whole pool, seeded so it's the same for everyone
  const poolRng = mulberry32(hashString("spoton-poolorder"));
  const shuffled = seededShuffle(pool.map((_, i) => i), poolRng);
  const start = page * Q_PER_GAME;
  let chosenIdx = shuffled.slice(start, start + Q_PER_GAME);
  // safety: if pool isn't a clean multiple, wrap to fill 15
  if (chosenIdx.length < Q_PER_GAME) {
    chosenIdx = chosenIdx.concat(shuffled.slice(0, Q_PER_GAME - chosenIdx.length));
  }
  const chosen = chosenIdx.map((i) => pool[i]);
  // order within the day varies by the day seed so two pages of the same
  // questions (only on tiny pools) still feel different
  const dayOrder = seededShuffle(chosen.map((_, i) => i), rng);
  const ordered = dayOrder.map((i) => chosen[i]);
  const sets = [];
  for (let b = 0; b < BOARDS_PER_GAME; b++) {
    sets.push(ordered.slice(b * Q_PER_BOARD, b * Q_PER_BOARD + Q_PER_BOARD));
  }
  return sets;
}

const LINES = 5;
const POSITIONS = 12;
const START_MS = 60000;
const BONUS_WINDOWS = [5, 4, 3]; // seconds, shrinks per level
const GUESSES = 3;
const MISS_PENALTY_MS = 3000;
const TOTAL_Q = 15;
const EPOCH = "2026-06-12"; // daily #1

// ---------- DAILY SEED ----------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dailyNumber(key) {
  const days = Math.round((new Date(key) - new Date(EPOCH)) / 86400000);
  return days + 1;
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- AUDIO ----------
let actx = null;
let audioUnlocked = false;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) actx = new AC();
  }
  return actx;
}
function unlockAudio() {
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  if (!audioUnlocked) {
    audioUnlocked = true;
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start(0);
    } catch {}
  }
}
function tone(t0, freq, dur, { type = "square", vol = 0.12, to = null } = {}) {
  const ctx = audio();
  if (!ctx) return;
  const schedule = () => {
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, ctx.currentTime + t0);
      if (to) o.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + t0 + dur);
      g.gain.setValueAtTime(vol, ctx.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t0);
      o.stop(ctx.currentTime + t0 + dur + 0.02);
    } catch {}
  };
  if (ctx.state === "suspended") ctx.resume().then(schedule).catch(() => {});
  else schedule();
}
const SFX = {
  coin() { tone(0, 988, 0.08, { vol: 0.15 }); tone(0.08, 1319, 0.3, { vol: 0.15 }); },
  correct() { tone(0, 660, 0.09); tone(0.08, 880, 0.09); tone(0.16, 1320, 0.18, { vol: 0.14 }); },
  wrong() { tone(0, 160, 0.28, { type: "sawtooth", to: 80, vol: 0.16 }); },
  flip() { tone(0, 220, 0.5, { type: "triangle", to: 1400, vol: 0.1 }); tone(0.1, 180, 0.5, { type: "triangle", to: 1100, vol: 0.07 }); },
  victory() {
    const notes = [523, 659, 784, 1047, 784, 1047, 1319];
    notes.forEach((f, i) => tone(i * 0.13, f, i === notes.length - 1 ? 0.5 : 0.12, { vol: 0.13 }));
  },
  timeout() { tone(0, 392, 0.25, { type: "sawtooth", vol: 0.12 }); tone(0.25, 330, 0.25, { type: "sawtooth", vol: 0.12 }); tone(0.5, 262, 0.6, { type: "sawtooth", to: 130, vol: 0.13 }); },
};

// ---------- GRID GENERATION (seeded) ----------
const FILLER = "BCDFGHJKLMNPQRSTVWXZBCDFGHKLMNPRSTKWXZQVJ";

function countOccurrences(rows, word) {
  let n = 0;
  for (const row of rows) {
    let idx = row.indexOf(word);
    while (idx !== -1) { n++; idx = row.indexOf(word, idx + 1); }
  }
  return n;
}

function buildBoard(answers, rng) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const grid = Array.from({ length: LINES }, () => Array(POSITIONS).fill(null));
    const occupied = Array.from({ length: LINES }, () => []);
    const placements = {};
    let ok = true;
    const sorted = [...answers].sort((a, b) => b.length - a.length);
    for (const word of sorted) {
      let placed = false;
      for (let tries = 0; tries < 150 && !placed; tries++) {
        const line = Math.floor(rng() * LINES);
        const maxStart = POSITIONS - word.length;
        if (maxStart < 0) break;
        const start = Math.floor(rng() * (maxStart + 1));
        const clash = occupied[line].some(([s, e]) => start <= e && start + word.length - 1 >= s);
        if (clash) continue;
        for (let i = 0; i < word.length; i++) grid[line][start + i] = word[i];
        occupied[line].push([start, start + word.length - 1]);
        placements[word] = { line, start };
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (!ok) continue;
    for (let l = 0; l < LINES; l++)
      for (let p = 0; p < POSITIONS; p++)
        if (grid[l][p] === null) grid[l][p] = FILLER[Math.floor(rng() * FILLER.length)];
    const rows = grid.map((r) => r.join(""));
    if (answers.every((w) => countOccurrences(rows, w) === 1)) return { grid, placements };
  }
  return null;
}

function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- STORAGE ----------
async function loadDaily(dateKey) {
  try {
    const res = await window.storage.get(`spoton-daily-${dateKey}`, true);
    return res ? JSON.parse(res.value) : [];
  } catch { return []; }
}
async function saveDaily(dateKey, entries) {
  try { await window.storage.set(`spoton-daily-${dateKey}`, JSON.stringify(entries), true); return true; }
  catch { return false; }
}
async function loadStats() {
  try { const res = await window.storage.get("spoton-stats", false); return res ? JSON.parse(res.value) : null; }
  catch { return null; }
}
async function saveStats(s) {
  try { await window.storage.set("spoton-stats", JSON.stringify(s), false); } catch {}
}
async function loadGold() {
  try { const res = await window.storage.get("spoton-gold", false); return !!res; }
  catch { return false; }
}
async function saveGold(v) {
  try { await window.storage.set("spoton-gold", v ? "1" : "0", false); } catch {}
}
function yesterdayOf(key) {
  const d = new Date(key); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function loadOnboarded() {
  try { const res = await window.storage.get("spoton-onboarded", false); return !!res; }
  catch { return false; }
}
async function saveOnboarded() {
  try { await window.storage.set("spoton-onboarded", "1", false); } catch {}
}
async function loadMyResult(dateKey) {
  try {
    const res = await window.storage.get(`spoton-me-${dateKey}`, false);
    return res ? JSON.parse(res.value) : null;
  } catch { return null; }
}
async function saveMyResult(dateKey, result) {
  try { await window.storage.set(`spoton-me-${dateKey}`, JSON.stringify(result), false); return true; }
  catch { return false; }
}

function rankEntries(entries) {
  return [...entries].sort((a, b) => b.solved - a.solved || b.timeLeftMs - a.timeLeftMs);
}
function fmtS(ms) { return (Math.max(0, ms) / 1000).toFixed(1); }

// ---------- COMPONENT ----------
export default function SpotOn() {
  const [phase, setPhase] = useState("loading"); // loading | intro | doneToday | play | levelup | enterScore | gameOver
  const [mode, setMode] = useState("daily"); // daily | practice
  const [level, setLevel] = useState(0);
  const [order, setOrder] = useState([]);
  const [qIdx, setQIdx] = useState(0);
  const [boards, setBoards] = useState(null); // all 3 prebuilt for determinism
  const [sets, setSets] = useState(null); // the 3x5 question sets for this game
  const [flipState, setFlipState] = useState("");
  const [splashLevel, setSplashLevel] = useState(2);
  const [timeMs, setTimeMs] = useState(START_MS);
  const [guesses, setGuesses] = useState(GUESSES);
  const [misses, setMisses] = useState([]);
  const [found, setFound] = useState([]);
  const [solved, setSolved] = useState(0);
  const [resultFlash, setResultFlash] = useState(null); // toast during play
  const [revealWord, setRevealWord] = useState(null); // {word, count}
  const [flash, setFlash] = useState("");
  const [floaters, setFloaters] = useState([]);
  const floaterId = useRef(0);
  const spawnFloater = (line, pos, text, kind) => {
    const id = ++floaterId.current;
    setFloaters((f) => [...f, { id, line, pos, text, kind }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 1800);
  };
  const [ranBoard, setRanBoard] = useState(false);
  const [finalTimeMs, setFinalTimeMs] = useState(0);
  const [muted, setMuted] = useState(false);
  const [daily, setDaily] = useState([]);
  const [myRank, setMyRank] = useState(null);
  const [myResult, setMyResult] = useState(null);
  const [initials, setInitials] = useState("");
  const [copied, setCopied] = useState(false);
  const [lbOffline, setLbOffline] = useState(false);
  const [stats, setStats] = useState(null);
  const [gold, setGold] = useState(false);
  const [archKey, setArchKey] = useState(null);
  const returnRef = useRef("ready");

  const timerRef = useRef(null);
  const lastTickRef = useRef(0);
  const timeMsRef = useRef(START_MS);
  const qStartRef = useRef(0);
  const solvedRef = useRef(0);
  const mutedRef = useRef(false);
  const levelRef = useRef(0);
  const inputLockRef = useRef(false);
  useEffect(() => { solvedRef.current = solved; }, [solved]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { levelRef.current = level; }, [level]);

  const dateKey = todayKey();
  const gameNo = dailyNumber(dateKey);
  const play_ = (name) => { if (!mutedRef.current) try { SFX[name](); } catch {} };

  const questions = ((sets || [[], [], []])[level]) || [];
  const question = (order.length ? questions[order[qIdx]] : questions[0]) || { q: "", a: "" };
  const answer = question.a;
  const board = boards ? boards[level] : null;
  const placement = board?.placements[answer];

  // boot: check if already played today
  useEffect(() => {
    (async () => {
      const mine = await loadMyResult(dateKey);
      const lb = await loadDaily(dateKey);
      const onboarded = await loadOnboarded();
      setStats(await loadStats());
      setGold(await loadGold());
      setDaily(rankEntries(lb));
      if (mine) {
        setMyResult(mine);
        setPhase("doneToday");
      } else if (onboarded) {
        setPhase("ready");
      } else {
        setPhase("intro");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGame = useCallback((gameMode, archiveKey = null) => {
    unlockAudio();
    if (!mutedRef.current) try { SFX.coin(); } catch {}
    setArchKey(archiveKey);
    const seed = gameMode === "daily" ? hashString(`spoton-${todayKey()}`)
      : gameMode === "archive" ? hashString(`spoton-${archiveKey}`)
      : (Math.random() * 2 ** 31) | 0;
    const rng = mulberry32(seed);
    const dateForSets = gameMode === "archive" ? archiveKey : todayKey();
    const daySets = pickDailySets(dateForSets, rng);
    setSets(daySets);
    const built = daySets.map((set) => {
      let b = null;
      while (!b) b = buildBoard(set.map((x) => x.a), rng);
      return b;
    });
    const orders = daySets.map(() => seededShuffle([0, 1, 2, 3, 4], rng));
    setBoards(built);
    built.orders = orders;
    setMode(gameMode);
    setLevel(0); levelRef.current = 0;
    setOrder(orders[0]);
    built._orders = orders;
    setQIdx(0);
    setSolved(0); solvedRef.current = 0;
    setFound([]);
    setRanBoard(false);
    setTimeMs(START_MS); timeMsRef.current = START_MS;
    setGuesses(GUESSES);
    setMisses([]);
    setResultFlash(null);
    setRevealWord(null);
    setFlash("");
    setFlipState("");
    setCopied(false);
    inputLockRef.current = false;
    qStartRef.current = performance.now();
    lastTickRef.current = performance.now();
    setPhase("play");
  }, []);

  // delta-based 100ms countdown
  useEffect(() => {
    if (phase !== "play") return;
    lastTickRef.current = performance.now();
    timerRef.current = setInterval(() => {
      const now = performance.now();
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      timeMsRef.current -= delta;
      if (timeMsRef.current <= 0) {
        timeMsRef.current = 0;
        setTimeMs(0);
        clearInterval(timerRef.current);
        finishGame(false);
      } else {
        setTimeMs(timeMsRef.current);
      }
    }, 100);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, qIdx, level]);

  const finishGame = (completedAll) => {
    clearInterval(timerRef.current);
    const won = completedAll && solvedRef.current === TOTAL_Q && timeMsRef.current > 0;
    setRanBoard(won);
    setFinalTimeMs(won || completedAll ? timeMsRef.current : 0);
    if (won) play_("victory");
    else if (!completedAll) play_("timeout");
    setTimeout(() => {
      if (mode === "daily") { setInitials(""); setPhase("enterScore"); }
      else setPhase("gameOver");
    }, won ? 700 : 1100);
  };

  const startLevelUp = (nextLevel) => {
    setSplashLevel(nextLevel + 1);
    setPhase("levelup");
    play_("flip");
    setTimeout(() => setFlipState("out"), 350);
    setTimeout(() => {
      setLevel(nextLevel); levelRef.current = nextLevel;
      setOrder(boards._orders[nextLevel]);
      setQIdx(0);
      setFound([]);
      setMisses([]);
      setRevealWord(null);
      setFlipState("in");
    }, 950);
    setTimeout(() => {
      setFlipState("");
      setGuesses(GUESSES);
      setFlash("");
      inputLockRef.current = false;
      qStartRef.current = performance.now();
      setPhase("play");
    }, 2100);
  };

  const endQuestion = (won) => {
    inputLockRef.current = true;
    const elapsedMs = performance.now() - qStartRef.current;
    let bonusMs = 0;
    if (won) {
      play_("correct");
      bonusMs = Math.max(0, BONUS_WINDOWS[levelRef.current] * 1000 - elapsedMs);
      if (bonusMs > 0) {
        timeMsRef.current += bonusMs;
        setTimeMs(timeMsRef.current);
        spawnFloater(placement.line, placement.start, `+${fmtS(bonusMs)} secs`, "good");
      }
    }
    setFound((f) => [...f, answer]);
    setResultFlash(won ? { won: true, bonusMs } : { won: false, word: answer });
    // sweep
    let i = 0;
    const sweep = setInterval(() => {
      i++;
      setRevealWord({ word: answer, count: i });
      if (i >= answer.length) clearInterval(sweep);
    }, 80);
    setTimeout(() => {
      clearInterval(sweep);
      setResultFlash(null);
      setRevealWord(null);
      if (qIdx + 1 < 5) {
        setQIdx((x) => x + 1);
        setGuesses(GUESSES);
        setMisses([]);
        setFlash("");
        inputLockRef.current = false;
        qStartRef.current = performance.now();
      } else if (level + 1 < BOARDS_PER_GAME) {
        startLevelUp(level + 1);
      } else {
        finishGame(true);
      }
    }, 1200);
  };

  const handleCell = (line, pos) => {
    if (phase !== "play" || inputLockRef.current) return;
    unlockAudio();
    const p = placement;
    if (line === p.line && pos === p.start) {
      setSolved((s) => { solvedRef.current = s + 1; return s + 1; });
      endQuestion(true);
      return;
    }
    play_("wrong");
    const inside = line === p.line && pos > p.start && pos < p.start + answer.length;
    spawnFloater(line, pos, `−${MISS_PENALTY_MS / 1000} secs`, "bad");
    setFlash(inside ? "Right word — tap the FIRST letter!" : "");
    setMisses((m) => [...m, { line, pos }]);
    timeMsRef.current -= MISS_PENALTY_MS;
    if (timeMsRef.current <= 0) {
      timeMsRef.current = 0;
      setTimeMs(0);
      clearInterval(timerRef.current);
      finishGame(false);
      return;
    }
    setTimeMs(timeMsRef.current);
    setGuesses((g) => {
      if (g - 1 <= 0) { endQuestion(false); return 0; }
      return g - 1;
    });
  };

  const submitScore = async () => {
    const name = (initials || "???").toUpperCase().padEnd(3, "\u00B7").slice(0, 3);
    const entry = {
      name,
      solved: solvedRef.current,
      timeLeftMs: Math.round(ranBoard ? finalTimeMs : 0) || (solvedRef.current === TOTAL_Q ? Math.round(finalTimeMs) : 0),
    };
    // non-finishers rank by words found; finishers by time left
    if (solvedRef.current < TOTAL_Q) entry.timeLeftMs = 0;
    const fresh = await loadDaily(dateKey);
    const merged = rankEntries([...fresh, entry]).slice(0, 50);
    const ok = await saveDaily(dateKey, merged);
    if (!ok) setLbOffline(true);
    const rank = merged.findIndex((e) => e === entry || (e.name === entry.name && e.solved === entry.solved && e.timeLeftMs === entry.timeLeftMs)) + 1;
    const mine = { name, solved: entry.solved, timeLeftMs: entry.timeLeftMs, rank, ran: ranBoard };
    await saveMyResult(dateKey, mine);
    setMyResult(mine);
    setMyRank(rank);
    setDaily(merged);
    // update streak + history
    const prev = (await loadStats()) || { streak: 0, maxStreak: 0, played: 0, ran: 0, lastDate: null, history: [] };
    const streak = prev.lastDate === yesterdayOf(dateKey) ? prev.streak + 1 : 1;
    const next = {
      streak,
      maxStreak: Math.max(prev.maxStreak, streak),
      played: prev.played + 1,
      ran: prev.ran + (ranBoard ? 1 : 0),
      bestTimeLeftMs: Math.max(prev.bestTimeLeftMs || 0, entry.timeLeftMs),
      lastDate: dateKey,
      history: [...(prev.history || []), { date: dateKey, solved: entry.solved, timeLeftMs: entry.timeLeftMs, ran: ranBoard }].slice(-365),
    };
    await saveStats(next);
    setStats(next);
    setPhase("gameOver");
  };

  const shareText = () => {
    const r = myResult || { solved, timeLeftMs: finalTimeMs, rank: myRank, ran: ranBoard };
    const streakBit = stats && stats.streak > 1 ? `\n\uD83D\uDD25 ${stats.streak}-day streak` : "";
    return `SPOT ON! Daily #${gameNo}\n${r.solved}/${TOTAL_Q} found${r.ran ? ` \u00B7 ${fmtS(r.timeLeftMs)}s left \u2B50` : ""}${r.rank ? ` \u00B7 Rank #${r.rank}` : ""}${streakBit}\nCan you run the board?`;
  };
  const copyShare = async () => {
    try { await navigator.clipboard.writeText(shareText()); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  const isRevealed = (l, p) => {
    if (!revealWord || !board) return false;
    const pl = board.placements[revealWord.word];
    return pl && l === pl.line && p >= pl.start && p < pl.start + revealWord.count;
  };
  const isSpent = (l, p) => {
    if (!board) return false;
    return found.some((w) => {
      const pl = board.placements[w];
      return pl && l === pl.line && p >= pl.start && p < pl.start + w.length;
    });
  };
  const isMiss = (l, p) => misses.some((m) => m.line === l && m.pos === p);
  const overallQ = level * 5 + qIdx + 1;

  const playing = phase === "play" || phase === "levelup";
  return (
    <div className={`stage ${playing ? "playing" : ""}`}>
      <style>{css}</style>

      <header className="marquee">
        <div className="marquee-inner">
          <span className="w1">SPOT</span>
          <span className="w2">ON!</span>
        </div>
        <button className="mute" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute sound" : "Mute sound"}>
          {muted ? "\uD83D\uDD07" : "\uD83D\uDD0A"}
        </button>
      </header>

      {phase === "loading" && <div className="panel"><p className="rules dim">Loading today's board\u2026</p></div>}

      {phase === "intro" && (
        <div className="panel">
          <p className="daily-no">DAILY #{gameNo}</p>
          <p className="tagline">60 seconds. {TOTAL_Q} questions. Can you run the board?</p>
          <p className="rules">
            Look hard — the answers are hiding right in front of your eyes.
            Spot the word and tap its <b>first letter</b> before the clock runs out.
          </p>
          <button className="cta" onClick={() => { unlockAudio(); setPhase("tutorial"); }}>Show me how</button>
          <button className="cta ghost" onClick={() => { saveOnboarded(); startGame("daily"); }}>Skip — I've played before</button>
        </div>
      )}

      {phase === "tutorial" && (
        <TutorialPanel
          onDone={() => { saveOnboarded(); startGame("daily"); }}
          playSfx={play_}
        />
      )}

      {phase === "ready" && (
        <div className="panel">
          <p className="daily-no">DAILY #{gameNo}</p>
          <p className="tagline">Can you run the board?</p>
          {stats && stats.streak > 1 && <p className="streak">🔥 {stats.streak}-day streak</p>}
          <button className="cta" onClick={() => startGame("daily")}>Play</button>
          <div className="btn-row">
            <button className="cta ghost" onClick={() => { returnRef.current = "ready"; setPhase("stats"); }}>Stats</button>
            <button className="cta ghost" onClick={() => { returnRef.current = "ready"; setPhase("archive"); }}>Archive</button>
          </div>
          <button className="linkish" onClick={() => setPhase("intro")}>How to play</button>
        </div>
      )}

      {phase === "doneToday" && (
        <div className="panel">
          <p className="daily-no">DAILY #{gameNo}</p>
          <p className="verdict win">You've run today's board.</p>
          {myResult && (
            <p className="rules">
              {myResult.solved}/{TOTAL_Q} found
              {myResult.ran ? <> &middot; <b>{fmtS(myResult.timeLeftMs)}s left</b></> : null}
              {myResult.rank ? <> &middot; Rank #{myResult.rank}</> : null}
            </p>
          )}
          <DailyBoard entries={daily} me={myResult} offline={lbOffline} />
          {stats && stats.streak > 1 && <p className="streak">🔥 {stats.streak}-day streak</p>}
          <div className="btn-row">
            <button className="cta" onClick={copyShare}>{copied ? "Copied!" : "Copy your flex"}</button>
            <button className="cta ghost" onClick={() => startGame("practice")}>Practice (unranked)</button>
          </div>
          <div className="btn-row">
            <button className="cta ghost" onClick={() => { returnRef.current = "doneToday"; setPhase("stats"); }}>Stats</button>
            <button className="cta ghost" onClick={() => { returnRef.current = "doneToday"; setPhase("archive"); }}>Archive</button>
          </div>
          <p className="rules dim">New board at midnight.</p>
        </div>
      )}

      {(phase === "play" || phase === "levelup") && board && (
        <>
          {mode === "practice" && <div className="practice-tag">PRACTICE &middot; UNRANKED</div>}
          <div className="hud">
            <div className={`hud-cell timer ${timeMs <= 10000 && phase === "play" ? "urgent" : ""}`}>
              <span className="hud-label">Clock</span>
              <span className="hud-val big-time">{fmtS(timeMs)}</span>
            </div>
            <div className="hud-cell">
              <span className="hud-label">Word</span>
              <span className="hud-val">{overallQ}/{TOTAL_Q}</span>
            </div>
            <div className="hud-cell">
              <span className="hud-label">Guesses</span>
              <span className="hud-val">{"\u25CF".repeat(guesses)}{"\u25CB".repeat(GUESSES - guesses)}</span>
            </div>
          </div>

          <div className="question">
            {phase === "levelup" ? <span className="getready">GET READY&hellip;</span> : question.q}
          </div>

          <div className="board-wrap">
            {phase === "levelup" && (
              <div className="levelsplash" aria-hidden="true"><span>LEVEL&nbsp;{splashLevel}</span></div>
            )}
            <div className={`board ${flipState === "out" ? "flip-out" : ""} ${flipState === "in" ? "flip-in" : ""}`} role="grid" aria-label="Letter board">
              {board.grid.map((row, l) => (
                <Row key={l} row={row} line={l} onCell={handleCell}
                  isRevealed={isRevealed} isSpent={isSpent} isMiss={isMiss}
                  floaters={floaters}
                  disabled={phase !== "play" || inputLockRef.current} />
              ))}
            </div>
          </div>

          {flash && phase === "play" && !resultFlash && <div className="flash">{flash}</div>}
          {resultFlash && (
            <div className={`toast ${resultFlash.won ? "win" : "lose"}`}>
              {resultFlash.won
                ? <>SPOT ON!</>
                : <>It was <b>{resultFlash.word}</b></>}
            </div>
          )}
        </>
      )}

      {phase === "enterScore" && (
        <div className="panel">
          {ranBoard && <BoogieBot />}
          <p className="verdict win big">{ranBoard ? `${fmtS(finalTimeMs)} SECS LEFT` : `${solved}/${TOTAL_Q} FOUND`}</p>
          <p className="rules">Add your name to today's leaderboard:</p>
          <input
            className="initials" value={initials} maxLength={3} autoFocus
            onChange={(e) => setInitials(e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && submitScore()}
            placeholder="AAA" aria-label="Your three initials"
          />
          <button className="cta" onClick={submitScore}>Lock it in</button>
        </div>
      )}

      {phase === "stats" && (
        <div className="panel">
          <p className="daily-no">YOUR STATS</p>
          {!gold ? (
            <GoldUpsell onUnlock={async () => { await saveGold(true); setGold(true); }} />
          ) : !stats ? (
            <p className="rules dim">Play your first daily to start your stats.</p>
          ) : (
            <div className="stat-grid">
              <div className="stat"><span className="stat-num">{stats.played}</span><span className="stat-label">Played</span></div>
              <div className="stat"><span className="stat-num">{stats.ran}</span><span className="stat-label">Boards run</span></div>
              <div className="stat"><span className="stat-num">{stats.played ? Math.round((stats.ran / stats.played) * 100) : 0}%</span><span className="stat-label">Run rate</span></div>
              <div className="stat"><span className="stat-num">{stats.streak}</span><span className="stat-label">Streak</span></div>
              <div className="stat"><span className="stat-num">{stats.maxStreak}</span><span className="stat-label">Best streak</span></div>
              <div className="stat"><span className="stat-num">{stats.bestTimeLeftMs ? fmtS(stats.bestTimeLeftMs) : "\u2014"}</span><span className="stat-label">Best time left</span></div>
            </div>
          )}
          <button className="cta ghost" onClick={() => setPhase(returnRef.current)}>Back</button>
        </div>
      )}

      {phase === "archive" && (
        <div className="panel">
          <p className="daily-no">THE ARCHIVE</p>
          {!gold ? (
            <GoldUpsell onUnlock={async () => { await saveGold(true); setGold(true); }} />
          ) : (
            <ArchiveList stats={stats} onPlay={(k) => startGame("archive", k)} todayK={dateKey} />
          )}
          <button className="cta ghost" onClick={() => setPhase(returnRef.current)}>Back</button>
        </div>
      )}

      {phase === "gameOver" && (
        <div className="panel sharecard">
          {ranBoard && <BoogieBot />}
          <p className="daily-no">{mode === "archive" ? `ARCHIVE \u00B7 ${archKey}` : `SPOT ON! DAILY #${gameNo}`}</p>
          <p className="verdict win big">
            {mode === "practice" ? (ranBoard ? `${fmtS(finalTimeMs)} SECS LEFT` : `${solved}/${TOTAL_Q} FOUND`) :
              myResult ? `RANK #${myResult.rank}` : "DONE"}
          </p>
          <p className="rules">
            {solved}/{TOTAL_Q} found
            {ranBoard ? <> &middot; <b>{fmtS(finalTimeMs)}s left</b> &#11088;</> : null}
          </p>
          {mode === "daily" && <DailyBoard entries={daily} me={myResult} offline={lbOffline} />}
          <div className="btn-row">
            {mode === "daily" && <button className="cta" onClick={copyShare}>{copied ? "Copied!" : "Copy your flex"}</button>}
            <button className="cta ghost" onClick={() => startGame("practice")}>Practice (unranked)</button>
          </div>
          {mode === "daily" && stats && stats.streak > 1 && <p className="streak">🔥 {stats.streak}-day streak</p>}
          {mode === "daily" && (
            <div className="btn-row">
              <button className="cta ghost" onClick={() => { returnRef.current = "gameOver"; setPhase("stats"); }}>Stats</button>
              <button className="cta ghost" onClick={() => { returnRef.current = "gameOver"; setPhase("archive"); }}>Archive</button>
            </div>
          )}
          {mode === "daily" && <p className="rules dim">Screenshot this. You earned it. New board at midnight.</p>}
        </div>
      )}
    </div>
  );
}

const DEMO_GRID = [
  "BRKDSGNHTLWC".split(""),
  "TRHMPUPPYKDS".split(""),
  "XLNBRTSGWKHM".split(""),
];
const DEMO = { word: "PUPPY", line: 1, start: 4 };

function TutorialPanel({ onDone, playSfx }) {
  const [msg, setMsg] = useState("");
  const [reveal, setReveal] = useState(0);
  const [misses, setMisses] = useState([]);
  const [won, setWon] = useState(false);

  const tap = (l, p) => {
    if (won) return;
    if (l === DEMO.line && p === DEMO.start) {
      playSfx("correct");
      setWon(true);
      setMsg("");
      let i = 0;
      const sweep = setInterval(() => {
        i++;
        setReveal(i);
        if (i >= DEMO.word.length) clearInterval(sweep);
      }, 90);
      setTimeout(onDone, 4000);
      return;
    }
    playSfx("wrong");
    setMisses((m) => [...m, { l, p }]);
    const inside = l === DEMO.line && p > DEMO.start && p < DEMO.start + DEMO.word.length;
    setMsg(inside ? "Right word — but always tap the FIRST letter." : "Not there — answers read left to right.");
  };

  return (
    <div className="panel">
      <p className="daily-no">WARM-UP &middot; NO CLOCK</p>
      <p className="rules">
        <b>What is a baby dog called?</b>
      </p>
      <p className="rules dim">The answer is hidden in the board. Tap its <b>first letter</b>.</p>
      <div className="board demo">
        {DEMO_GRID.map((row, l) =>
          row.map((ch, p) => {
            const lit = won && l === DEMO.line && p >= DEMO.start && p < DEMO.start + reveal;
            const miss = misses.some((m) => m.l === l && m.p === p);
            return (
              <button key={`${l}-${p}`}
                className={`cell ${lit ? "lit" : ""} ${miss ? "miss" : ""}`}
                onClick={() => tap(l, p)}
                aria-label={`Row ${l + 1} position ${p + 1}, letter ${ch}`}>
                {ch}
              </button>
            );
          })
        )}
      </div>
      {msg && <p className="flash">{msg}</p>}
      {won && <p className="verdict win">SPOT ON! In the real game misses cost time. Ready? Here comes the clock…</p>}
    </div>
  );
}

function Row({ row, line, onCell, isRevealed, isSpent, isMiss, floaters = [], disabled }) {
  return (
    <>
      {row.map((ch, p) => {
        const lit = isRevealed(line, p);
        const spent = !lit && isSpent(line, p);
        const miss = isMiss(line, p);
        const fl = floaters.find((f) => f.line === line && f.pos === p);
        return (
          <button key={p}
            className={`cell ${lit ? "lit" : ""} ${spent ? "spent" : ""} ${miss ? "miss" : ""}`}
            onClick={() => onCell(line, p)} disabled={disabled || spent}
            aria-label={`Line ${line + 1} position ${p + 1}, letter ${ch}`}>
            {ch}
            {fl && <span className={`floater ${fl.kind}`}>{fl.text}</span>}
          </button>
        );
      })}
    </>
  );
}

function DailyBoard({ entries, me, offline }) {
  const top = entries.slice(0, 10);
  return (
    <div className="lb">
      <div className="lb-title">&#9733; TODAY'S BOARD &#9733;</div>
      {offline && <div className="lb-row dim">SCOREBOARD OFFLINE</div>}
      {top.length === 0 && <div className="lb-row dim">NO RUNS YET — BE FIRST</div>}
      {top.map((e, i) => (
        <div key={i} className={`lb-row ${me && e.name === me.name && e.solved === me.solved && e.timeLeftMs === me.timeLeftMs ? "me" : ""}`}>
          <span className="lb-rank">{String(i + 1).padStart(2, "0")}</span>
          <span className="lb-name">{e.name}{e.solved === 15 && e.timeLeftMs > 0 ? " \u2605" : ""}</span>
          <span className="lb-detail">{e.solved}/15</span>
          <span className="lb-score">{e.timeLeftMs > 0 ? `${fmtS(e.timeLeftMs)}s` : "\u2014"}</span>
        </div>
      ))}
      {me && me.rank > 10 && (
        <div className="lb-row me">
          <span className="lb-rank">{String(me.rank).padStart(2, "0")}</span>
          <span className="lb-name">{me.name}</span>
          <span className="lb-detail">{me.solved}/15</span>
          <span className="lb-score">{me.timeLeftMs > 0 ? `${fmtS(me.timeLeftMs)}s` : "\u2014"}</span>
        </div>
      )}
    </div>
  );
}

function GoldUpsell({ onUnlock }) {
  return (
    <div className="gold-box">
      <p className="gold-title">SPOT ON! GOLD</p>
      <p className="rules">Unlock the full archive of past boards, your complete stats, and unlimited practice.</p>
      <p className="rules dim">Payments aren't wired up in this prototype — this button previews the unlocked experience.</p>
      <button className="cta" onClick={onUnlock}>Preview Gold (demo)</button>
    </div>
  );
}

function ArchiveList({ stats, onPlay, todayK }) {
  const dates = [];
  let d = new Date(EPOCH);
  const today = new Date(todayK);
  while (d < today) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    dates.push(k);
    d = new Date(d); d.setDate(d.getDate() + 1);
  }
  if (dates.length === 0) return <p className="rules dim">No past boards yet — the archive grows every midnight.</p>;
  const playedSet = new Set((stats?.history || []).map((h) => h.date));
  return (
    <div className="lb">
      {dates.reverse().map((k) => (
        <div key={k} className="lb-row">
          <span className="lb-name">#{dailyNumber(k)} &middot; {k}</span>
          <span className="lb-detail">{playedSet.has(k) ? "played" : ""}</span>
          <button className="linkish" onClick={() => onPlay(k)}>Play (unranked)</button>
        </div>
      ))}
    </div>
  );
}

function BoogieBot() {
  return (
    <div className="boogiebot-stage" role="img" aria-label="A robot breakdancing in celebration">
      <div className="disco">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className={`tile t${i % 4}`} />)}
      </div>
      <div className="boogiebot">
        <div className="antenna"><div className="bulb" /></div>
        <div className="head">
          <div className="eye e1" /><div className="eye e2" />
          <div className="mouth" />
        </div>
        <div className="arm left" />
        <div className="arm right" />
        <div className="torso">
          <div className="panel-light p1" /><div className="panel-light p2" /><div className="panel-light p3" />
        </div>
        <div className="leg left" />
        <div className="leg right" />
      </div>
    </div>
  );
}

// ---------- STYLES ----------
const css = `
@import url('https://fonts.googleapis.com/css2?family=Bungee&family=IBM+Plex+Mono:wght@500;700&display=swap');

* { box-sizing: border-box; }
.stage {
  min-height: 100vh;
  background:
    radial-gradient(ellipse 120% 70% at 50% -10%, #2a3f9e 0%, transparent 60%),
    #0c1145;
  color: #f5ecd7;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  display: flex; flex-direction: column; align-items: center;
  padding: 20px 12px 48px; gap: 16px;
}
.marquee { text-align: center; margin-top: 4px; position: relative; width: min(760px,100%); }
.marquee-inner {
  font-family: 'Bungee', 'Arial Black', sans-serif;
  font-size: clamp(30px, 8vw, 54px);
  line-height: 1; letter-spacing: 1px;
  display: flex; gap: 12px; justify-content: center; align-items: baseline;
}
.w1 { color: #ffd24a; text-shadow: 0 0 18px rgba(255,210,74,.55), 3px 3px 0 #7a1fa0; }
.w2 { color: #59e8ff; text-shadow: 0 0 18px rgba(89,232,255,.55), 3px 3px 0 #7a1fa0; }
.mute {
  position: absolute; right: 0; top: 0;
  background: transparent; border: 1px solid #3a44a8; border-radius: 6px;
  font-size: 16px; padding: 4px 8px; cursor: pointer; color: #f5ecd7;
}
.daily-no { margin: 0; font-size: 11px; letter-spacing: .35em; color: #59e8ff; }
.practice-tag {
  font-size: 11px; letter-spacing: .3em; color: #ff5fb2;
  border: 1px solid #ff5fb2; border-radius: 4px; padding: 3px 10px;
}

.hud { display: flex; gap: 8px; width: min(760px, 100%); }
.hud-cell { flex: 1; background: #141a5e; border: 1px solid #3a44a8; border-radius: 6px; padding: 6px 8px; text-align: center; }
.hud-cell.timer { flex: 1.5; }
.hud-cell.urgent { border-color: #ff5fb2; animation: pulse .6s infinite alternate; }
@keyframes pulse { from { box-shadow: 0 0 0 rgba(255,95,178,0);} to { box-shadow: 0 0 16px rgba(255,95,178,.6);} }
.hud-label { display: block; font-size: 9px; letter-spacing: .22em; color: #8a93d8; }
.hud-val { font-size: 18px; font-weight: 700; color: #ffd24a; }
.big-time { font-size: 26px; color: #59e8ff; font-variant-numeric: tabular-nums; }

.getready {
  display: block; text-align: center;
  font-family: 'Bungee', sans-serif;
  font-size: clamp(26px, 8vw, 44px);
  color: #59e8ff;
  text-shadow: 0 0 8px rgba(89,232,255,.9), 0 0 24px rgba(89,232,255,.6), 0 0 48px rgba(89,232,255,.35);
  animation: neonpulse 1s ease-in-out infinite alternate;
}
@keyframes neonpulse {
  from { text-shadow: 0 0 8px rgba(89,232,255,.9), 0 0 24px rgba(89,232,255,.6), 0 0 48px rgba(89,232,255,.35); }
  to   { text-shadow: 0 0 12px rgba(89,232,255,1), 0 0 36px rgba(89,232,255,.85), 0 0 70px rgba(89,232,255,.5); }
}
.stage.playing { gap: 10px; }
.stage.playing .marquee { margin-top: 0; }
.stage.playing .marquee-inner { font-size: clamp(20px, 5vw, 30px); }
.question {
  width: min(760px, 100%); background: #141a5e; border: 1px solid #3a44a8;
  border-radius: 8px; padding: 13px 16px; font-size: clamp(20px, 5.8vw, 27px); line-height: 1.32;
  min-height: 78px; display: flex; align-items: center; justify-content: center; text-align: center;
}

.board-wrap { width: min(760px, 100%); position: relative; perspective: 900px; }
.board {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: clamp(2px, 0.6vw, 5px);
  background: #090d38; padding: clamp(6px, 1.6vw, 12px); border-radius: 10px;
  border: 2px solid #3a44a8;
  box-shadow: inset 0 0 30px rgba(0,0,0,.6);
  transform-style: preserve-3d;
}
.board.flip-out { animation: flipOut .6s ease-in forwards; }
.board.flip-in  { animation: flipIn .6s ease-out forwards; }
@keyframes flipOut { from { transform: rotateX(0); } to { transform: rotateX(90deg); } }
@keyframes flipIn  { from { transform: rotateX(-90deg); } to { transform: rotateX(0); } }

.levelsplash {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.levelsplash span {
  font-family: 'Bungee', sans-serif;
  font-size: clamp(40px, 12vw, 84px);
  color: #ff5fb2;
  text-shadow: 0 0 24px rgba(255,95,178,.8), 4px 4px 0 #2a0a52;
  animation: splash 2s ease both;
}
@keyframes splash {
  0% { transform: scale(.2) rotate(-8deg); opacity: 0; }
  20% { transform: scale(1.15) rotate(2deg); opacity: 1; }
  30% { transform: scale(1); }
  80% { transform: scale(1); opacity: 1; }
  100% { transform: scale(1.4); opacity: 0; }
}

.cell {
  height: clamp(48px, 13vw, 66px); min-width: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: 'IBM Plex Mono', monospace; font-weight: 700;
  font-size: clamp(18px, 5.6vw, 32px);
  color: #d8c07a;
  background: linear-gradient(180deg, #1b2270 0%, #11164f 100%);
  border: 1px solid #2c358e; border-radius: 5px;
  cursor: pointer; padding: 0;
  transition: transform .08s ease, background .15s ease;
}
.cell:hover:not(:disabled) { transform: scale(1.1); background: #232b8a; color: #ffe9a8; }
.cell:focus-visible { outline: 2px solid #59e8ff; outline-offset: 1px; }
.cell:disabled { cursor: default; }
.cell { position: relative; overflow: visible; }
.floater {
  position: absolute; top: -6px; left: 50%; z-index: 12;
  font-family: 'Bungee', sans-serif; font-size: clamp(12px, 3.3vw, 16px);
  pointer-events: none; white-space: nowrap;
  animation: floatup 1.8s ease-out forwards;
}
.floater.good { color: #ffd24a; text-shadow: 0 0 10px rgba(255,210,74,.8); }
.floater.bad  { color: #ff5fb2; text-shadow: 0 0 10px rgba(255,95,178,.8); }
@keyframes floatup {
  0%   { opacity: 0; transform: translate(-50%, 4px) scale(.6); }
  10%  { opacity: 1; transform: translate(-50%, -6px) scale(1.15); }
  60%  { opacity: 1; transform: translate(-50%, -14px) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -38px) scale(1); }
}
.cell.lit {
  background: radial-gradient(circle at 50% 35%, #ffe9a8 0%, #ffb73a 70%);
  color: #5a2d00; border-color: #ffd24a;
  box-shadow: 0 0 14px rgba(255,200,60,.8);
  animation: ignite .25s ease;
}
@keyframes ignite { from { transform: scale(.7); } to { transform: scale(1); } }
.cell.spent { background: #0d1142; color: #3d4690; border-color: #1d2470; }
.cell.miss { background: #4a1030; color: #ff5fb2; border-color: #ff5fb2; }

.flash { font-size: 13px; color: #ff5fb2; letter-spacing: .05em; }

.toast {
  width: min(760px, 100%); text-align: center;
  font-family: 'Bungee', sans-serif; font-size: 18px;
  padding: 12px; border-radius: 8px;
}
.toast.win { color: #ffd24a; background: rgba(255,210,74,.08); }
.toast.lose { color: #ff5fb2; background: rgba(255,95,178,.08); }
.toast .bonus { color: #59e8ff; }

.panel {
  width: min(760px, 100%); background: #141a5e; border: 1px solid #3a44a8;
  border-radius: 10px; padding: 22px; text-align: center;
  display: flex; flex-direction: column; gap: 14px; align-items: center;
}
.sharecard { border-color: #ffd24a; box-shadow: 0 0 24px rgba(255,210,74,.15); }
.rules { margin: 0; font-size: 14px; line-height: 1.55; }
.tagline { margin: 0; font-family: 'Bungee', sans-serif; font-size: 17px; color: #ffd24a; line-height: 1.4; }
.dim { color: #8a93d8; font-size: 13px; }
.verdict { margin: 0; font-size: 16px; line-height: 1.5; }
.verdict.win { color: #ffd24a; }
.verdict.lose { color: #ff5fb2; }
.verdict.big { font-family: 'Bungee', sans-serif; font-size: 28px; }

.btn-row { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
.cta {
  font-family: 'Bungee', 'Arial Black', sans-serif;
  font-size: 15px; letter-spacing: .06em;
  color: #0c1145; background: linear-gradient(180deg, #ffe9a8, #ffb73a);
  border: none; border-radius: 8px; padding: 12px 26px; cursor: pointer;
  box-shadow: 0 4px 0 #9a6a10, 0 0 18px rgba(255,200,60,.35);
}
.cta:active { transform: translateY(3px); box-shadow: 0 1px 0 #9a6a10; }
.cta.ghost { color: #59e8ff; background: transparent; border: 2px solid #59e8ff; box-shadow: none; }

.initials {
  font-family: 'Bungee', monospace;
  font-size: 34px; text-align: center; letter-spacing: .35em;
  width: 180px; padding: 10px 0 10px 12px;
  color: #ffd24a; background: #090d38;
  border: 2px solid #3a44a8; border-radius: 8px;
  caret-color: #59e8ff;
}
.initials:focus { outline: none; border-color: #ffd24a; }

.board.demo {
  grid-template-columns: repeat(12, 1fr);
  width: 100%;
}
.linkish {
  background: none; border: none; cursor: pointer;
  color: #8a93d8; font-family: inherit; font-size: 13px;
  text-decoration: underline; padding: 0;
}
.streak { margin: 0; font-size: 15px; color: #ffd24a; letter-spacing: .05em; }
.stat-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  width: min(460px, 100%);
}
.stat {
  background: #090d38; border: 1px solid #3a44a8; border-radius: 8px;
  padding: 12px 6px; display: flex; flex-direction: column; gap: 4px;
}
.stat-num { font-family: 'Bungee', sans-serif; font-size: 22px; color: #ffd24a; }
.stat-label { font-size: 10px; letter-spacing: .15em; color: #8a93d8; }
.gold-box {
  border: 2px solid #ffd24a; border-radius: 10px; padding: 18px;
  display: flex; flex-direction: column; gap: 10px; align-items: center;
  background: rgba(255,210,74,.05); box-shadow: 0 0 24px rgba(255,210,74,.15);
  width: min(460px, 100%);
}
.gold-title {
  margin: 0; font-family: 'Bungee', sans-serif; font-size: 20px;
  color: #ffd24a; text-shadow: 0 0 14px rgba(255,210,74,.6);
}
.lb { width: min(460px, 100%); display: flex; flex-direction: column; gap: 6px; }
.lb-title { font-family: 'Bungee', sans-serif; font-size: 18px; color: #ff5fb2; text-shadow: 0 0 12px rgba(255,95,178,.5); margin-bottom: 6px; }
.lb-row { display: flex; gap: 10px; justify-content: space-between; font-size: 15px; font-weight: 700; padding: 4px 10px; }
.lb-row.me { background: rgba(255,210,74,.12); border-radius: 4px; color: #ffd24a; }
.lb-rank { color: #6470c4; min-width: 24px; text-align: left; }
.lb-name { color: #59e8ff; letter-spacing: .2em; flex: 1; text-align: left; }
.lb-detail { color: #8a93d8; }
.lb-score { color: #ffd24a; min-width: 56px; text-align: right; font-variant-numeric: tabular-nums; }

/* ---------- BOOGIEBOT ---------- */
.boogiebot-stage {
  position: relative; width: 220px; height: 230px;
  display: flex; align-items: flex-end; justify-content: center;
  overflow: visible;
}
.disco {
  position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
  display: grid; grid-template-columns: repeat(8, 26px); gap: 2px;
}
.tile { height: 14px; border-radius: 2px; animation: discoflash 1s infinite; }
.tile.t0 { background: #ff5fb2; animation-delay: 0s; }
.tile.t1 { background: #ffd24a; animation-delay: .25s; }
.tile.t2 { background: #59e8ff; animation-delay: .5s; }
.tile.t3 { background: #9a5bff; animation-delay: .75s; }
@keyframes discoflash { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
.boogiebot {
  position: relative; width: 90px; height: 170px; margin-bottom: 18px;
  transform-origin: 50% 90%;
  animation: bodyspin 2.4s ease-in-out infinite;
}
@keyframes bodyspin {
  0%   { transform: rotate(0) translateY(0); }
  15%  { transform: rotate(-14deg) translateY(-6px); }
  30%  { transform: rotate(14deg) translateY(-6px); }
  45%  { transform: rotate(0) translateY(0); }
  60%  { transform: rotate(360deg) translateY(-14px); }
  75%  { transform: rotate(360deg) translateY(0); }
  87%  { transform: rotate(346deg) translateY(-5px); }
  100% { transform: rotate(360deg) translateY(0); }
}
.antenna { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); width: 3px; height: 16px; background: #8a93d8; }
.bulb {
  position: absolute; top: -8px; left: 50%; transform: translateX(-50%);
  width: 10px; height: 10px; border-radius: 50%;
  background: #ff5fb2; box-shadow: 0 0 10px #ff5fb2;
  animation: bulbblink .5s infinite alternate;
}
@keyframes bulbblink { from { background: #ff5fb2; box-shadow: 0 0 10px #ff5fb2; } to { background: #59e8ff; box-shadow: 0 0 12px #59e8ff; } }
.head {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  width: 56px; height: 44px; border-radius: 10px;
  background: linear-gradient(180deg, #b8c4e8, #7f8ec4);
  border: 2px solid #4a5694;
  animation: headbop 1.2s ease-in-out infinite;
}
@keyframes headbop { 0%,100% { transform: translateX(-50%) rotate(-6deg);} 50% { transform: translateX(-50%) rotate(6deg);} }
.eye {
  position: absolute; top: 12px; width: 12px; height: 12px; border-radius: 50%;
  background: #59e8ff; box-shadow: 0 0 8px #59e8ff;
  animation: bulbblink .8s infinite alternate;
}
.eye.e1 { left: 9px; } .eye.e2 { right: 9px; }
.mouth {
  position: absolute; bottom: 7px; left: 50%; transform: translateX(-50%);
  width: 26px; height: 6px; border-radius: 3px;
  background: repeating-linear-gradient(90deg, #ffd24a 0 4px, #4a5694 4px 7px);
}
.torso {
  position: absolute; top: 48px; left: 50%; transform: translateX(-50%);
  width: 64px; height: 62px; border-radius: 10px;
  background: linear-gradient(180deg, #98a6d6, #6674ad);
  border: 2px solid #4a5694;
  display: flex; gap: 5px; align-items: center; justify-content: center;
}
.panel-light { width: 10px; height: 10px; border-radius: 50%; animation: discoflash .9s infinite; }
.panel-light.p1 { background: #ff5fb2; } .panel-light.p2 { background: #ffd24a; animation-delay: .3s; } .panel-light.p3 { background: #59e8ff; animation-delay: .6s; }
.arm {
  position: absolute; top: 50px; width: 12px; height: 52px; border-radius: 6px;
  background: linear-gradient(180deg, #b8c4e8, #7f8ec4); border: 2px solid #4a5694;
}
.arm.left  { left: -4px;  transform-origin: 50% 8%; animation: armwaveL 1.2s ease-in-out infinite; }
.arm.right { right: -4px; transform-origin: 50% 8%; animation: armwaveR 1.2s ease-in-out infinite; }
@keyframes armwaveL { 0%,100% { transform: rotate(50deg);}  50% { transform: rotate(-130deg);} }
@keyframes armwaveR { 0%,100% { transform: rotate(-130deg);} 50% { transform: rotate(50deg);} }
.leg {
  position: absolute; top: 112px; width: 14px; height: 50px; border-radius: 7px;
  background: linear-gradient(180deg, #98a6d6, #6674ad); border: 2px solid #4a5694;
}
.leg.left  { left: 18px;  transform-origin: 50% 5%; animation: kickL 1.2s ease-in-out infinite; }
.leg.right { right: 18px; transform-origin: 50% 5%; animation: kickR 1.2s ease-in-out infinite; }
@keyframes kickL { 0%,100% { transform: rotate(0);}   40% { transform: rotate(38deg);} }
@keyframes kickR { 0%,100% { transform: rotate(0);}   70% { transform: rotate(-38deg);} }

@media (prefers-reduced-motion: reduce) {
  .cell.lit, .hud-cell.urgent, .boogiebot, .head, .arm, .leg, .tile, .bulb, .eye, .panel-light, .levelsplash span { animation: none; }
  .cell, .cta { transition: none; }
  .getready { animation: none; }
  .board.flip-out, .board.flip-in { animation-duration: .01s; }
}
`;
