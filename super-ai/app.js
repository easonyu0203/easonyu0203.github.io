// One page for every game: the server says which games there are, and each
// kind of board has a renderer in `BOARDS`.

// The page on GitHub Pages calls the API on the server; anywhere else, such
// as when the server itself serves the page, it's the same address.
const API = location.hostname.endsWith("github.io")
  ? "https://eason-blacky.tail8a6998.ts.net:8443"
  : "";
const THINK_MS = 350; // So you see your disc land before the agent's reply.
const $ = (id) => document.getElementById(id);

function stored(key, make) {
  // Storage can be unavailable, such as in a private window; everything
  // still works, except that a reload starts over.
  try {
    let value = localStorage.getItem(key);
    if (value === null && make) {
      value = make();
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return make ? make() : null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

const player = stored("player", () => crypto.randomUUID());
let games = [];
let selected = null;
let game = null; // The game in play, as the server last described it.
let busy = false;

async function call(path, body) {
  const response = await fetch(API + path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// Rendering.

function winningCells(board, connect) {
  const cells = new Set();
  const height = board.length, width = board[0].length;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (board[r][c] < 0) continue;
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const line = Array.from({ length: connect }, (_, i) => [r + i * dr, c + i * dc]);
        if (line.every(([y, x]) => y >= 0 && y < height && x >= 0 && x < width && board[y][x] === board[r][c])) {
          for (const [y, x] of line) cells.add(`${y},${x}`);
        }
      }
    }
  }
  return cells;
}

// A board where a move is a column, and the disc falls in it.
function renderDrop(element, info, state, previous, canMove) {
  const { height, width } = info;
  element.style.gridTemplateColumns = `repeat(${width}, 1fr)`;
  element.replaceChildren();
  element.classList.toggle("over", Boolean(state.result));
  const won = state.result && state.result !== "abandoned" ? winningCells(state.board, info.connect) : new Set();
  const last = state.moves.length ? state.moves.at(-1) : null;
  let lastRow = null;
  if (last !== null) lastRow = state.board.findIndex((row) => row[last] >= 0);
  const before = new Set();
  if (previous) previous.forEach((row, r) => row.forEach((seat, c) => { if (seat >= 0) before.add(`${r},${c}`); }));

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      const seat = state.board[r][c];
      if (seat >= 0) cell.classList.add(`seat${seat}`);
      if (c === last && r === lastRow && !won.size) cell.classList.add("last");
      if (won.has(`${r},${c}`)) cell.classList.add("won");
      if (seat >= 0 && previous && !before.has(`${r},${c}`)) {
        cell.classList.add("dropped");
        cell.style.setProperty("--from", `${-(r + 1) * 110}%`);
      }
      const open = canMove && state.legal && state.legal[c];
      cell.disabled = !open;
      cell.setAttribute("aria-label", `Column ${c + 1}, row ${height - r}: ${seat < 0 ? "empty" : seat === state.human_seat ? "yours" : "the AI's"}`);
      if (open) {
        cell.dataset.column = c;
        cell.addEventListener("click", () => play(c));
        cell.addEventListener("pointerenter", (event) => {
          if (event.pointerType === "mouse") hover(element, state, c);
        });
        cell.addEventListener("pointerleave", () => hover(element, state, null));
      }
      element.append(cell);
    }
  }
}

function hover(element, state, column) {
  element.querySelectorAll(".landing").forEach((cell) => {
    cell.classList.remove("landing", `seat${state.human_seat}`);
  });
  if (column === null) {
    delete element.dataset.hover;
    return;
  }
  const row = state.board.findLastIndex((cells) => cells[column] < 0);
  const cell = element.children[row * state.board[0].length + column];
  cell.classList.add("landing", `seat${state.human_seat}`);
  element.dataset.hover = "";
}

const BOARDS = { drop: renderDrop };

function describe(state) {
  switch (state.result) {
    case "win": return "You won! 🎉";
    case "loss": return "The AI won.";
    case "draw": return "A draw.";
    case "abandoned": return "This game timed out.";
    default:
      return state.moves.length ? "Your move." : "You move first. Pick a column.";
  }
}

function render(state, previous, message) {
  const info = selected;
  const element = $("board");
  element.hidden = false;
  BOARDS[info.board](element, info, state, previous, !busy && !state.result);
  $("status").textContent = message ?? describe(state);
  showThinking(state);
  $("new").hidden = false;
  $("new").textContent = state.result ? "Play again" : "New game";
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : word.endsWith("s") ? "es" : "s"}`;
}

// One person's or everyone's record: the rate, its split, and its counts.
function rate(name, record) {
  const { win, draw, loss } = record;
  const finished = win + draw + loss;
  const element = document.createElement("div");
  element.className = "rate";
  const head = document.createElement("div");
  head.className = "rate-head";
  const label = document.createElement("span");
  label.textContent = name;
  const value = document.createElement("strong");
  value.textContent = finished ? `${Math.round((100 * win) / finished)}%` : "–";
  head.append(label, value);
  const bar = document.createElement("div");
  bar.className = "rate-bar";
  bar.setAttribute("role", "img");
  const counts = finished
    ? `${plural(win, "win")}, ${plural(draw, "draw")}, ${plural(loss, "loss")}`
    : "No finished games yet";
  bar.setAttribute("aria-label", `${name}: ${counts}`);
  for (const [outcome, count] of [["win", win], ["draw", draw], ["loss", loss]]) {
    if (!count) continue;
    const segment = document.createElement("i");
    segment.className = outcome;
    segment.style.flexGrow = count;
    segment.title = `${plural(count, outcome)} (${Math.round((100 * count) / finished)}%)`;
    bar.append(segment);
  }
  const line = document.createElement("div");
  line.className = "rate-counts";
  line.textContent = counts;
  element.append(head, bar, line);
  return element;
}

async function showRecord() {
  try {
    const stats = await call(`/games/${selected.id}/stats?player=${encodeURIComponent(player)}`);
    $("rates").replaceChildren(rate("You", stats.you), rate("All humans", stats.all));
    $("record").hidden = false;
  } catch {
    // The record is a nicety: the game goes on without it.
  }
}

// The AI's probabilities on its last move, under the board's columns.
function showThinking(state) {
  $("thinking").hidden = false;
  const bars = $("bars");
  bars.style.setProperty("--columns", selected.width);
  if (!state.agent_move) {
    bars.replaceChildren();
    $("thought").textContent = "How likely the AI is to play each column shows here after it moves.";
    return;
  }
  const { action, policy } = state.agent_move;
  const LABEL_HEIGHT = 16; // Of a bar's 60px, kept for its percentage.
  bars.replaceChildren(...policy.map((probability, column) => {
    const percent = Math.round(probability * 100);
    const element = document.createElement("div");
    element.className = column === action ? "column chosen" : "column";
    element.title = `Column ${column + 1}: ${(probability * 100).toFixed(1)}%`;
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", element.title);
    if (percent >= 10 || column === action) {
      const label = document.createElement("b");
      label.textContent = `${percent}%`;
      element.append(label);
    }
    if (probability >= 0.005) {
      const bar = document.createElement("i");
      bar.style.height = `${Math.max(2, probability * (60 - LABEL_HEIGHT))}px`;
      element.append(bar);
    }
    return element;
  }));
  $("thought").textContent = `How likely the AI was to play each column. It chose column ${action + 1}.`;
}

// Playing.

function offline() {
  $("status").textContent = "The AI is offline right now. Please try again later.";
}

function gameKey() {
  return `game:${selected.id}`;
}

async function newGame() {
  busy = true;
  try {
    game = await call(`/games/${selected.id}/play`, { player });
    store(gameKey(), game.id);
    busy = false;
    render(game);
    showRecord();
  } catch (error) {
    busy = false;
    if (error.status === 429) $("status").textContent = "Lots of games are starting right now. Try again in a minute.";
    else offline();
  }
}

async function play(column) {
  if (busy || !game || game.result) return;
  busy = true;
  const previous = game;
  // Show the disc at once; the agent's reply takes a moment.
  const row = previous.board.findLastIndex((cells) => cells[column] < 0);
  const board = previous.board.map((cells) => [...cells]);
  board[row][column] = previous.human_seat;
  const shown = { ...previous, board, moves: [...previous.moves, column], legal: null };
  render(shown, previous.board, "The AI is thinking…");
  try {
    const [next] = await Promise.all([
      call(`/play/${previous.id}/moves`, { action: column }),
      new Promise((resolve) => setTimeout(resolve, THINK_MS)),
    ]);
    game = next;
    busy = false;
    render(next, board);
    if (next.result) finished();
  } catch (error) {
    busy = false;
    if (error.status === 409 || error.status === 404) {
      // It timed out, or was replaced from another tab.
      game = null;
      store(gameKey(), null);
      $("status").textContent = "That game has ended. Start a new one.";
      $("new").textContent = "Play again";
    } else {
      game = previous;
      render(previous);
      $("status").textContent = "Couldn't reach the AI. Try that move again.";
    }
  }
}

function finished() {
  store(gameKey(), null);
  showRecord();
}

async function open(info) {
  selected = info;
  $("title").textContent = `${info.name} against the AI`;
  document.title = `${info.name} vs. AI`;
  for (const link of $("picker").children) {
    if (link.dataset.game === info.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const saved = stored(gameKey());
  if (saved) {
    try {
      const state = await call(`/play/${saved}`);
      // It may be against an earlier agent, and still finishes against it.
      if (!state.result) {
        game = state;
        render(state);
        showRecord();
        return;
      }
    } catch (error) {
      if (!error.status) return offline();
    }
    store(gameKey(), null);
  }
  await newGame();
}

function fromHash() {
  const id = location.hash.slice(1);
  return games.find((info) => info.id === id) ?? games[0];
}

async function main() {
  $("new").addEventListener("click", newGame);
  try {
    games = await call("/games");
  } catch {
    return offline();
  }
  if (!games.length) return offline();
  // A picker only once there's a choice.
  if (games.length > 1) {
    $("picker").hidden = false;
    $("picker").replaceChildren(...games.map((info) => {
      const link = document.createElement("a");
      link.href = `#${info.id}`;
      link.textContent = info.name;
      link.dataset.game = info.id;
      return link;
    }));
  }
  window.addEventListener("hashchange", () => open(fromHash()));
  await open(fromHash());
}

main();
