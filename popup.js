// chrome.storage.local key for the user's TMDB v3 API key string
const STORAGE_KEY = "tmdbApiKey";
// chrome.storage.local key for the whole recommendation session (favourites, ratings, etc.)
const SESSION_KEY = "pickerSession";

// Base URL for all TMDB REST API v3 calls (paths are appended after this)
const TMDB_BASE = "https://api.themoviedb.org/3";
// TMDB image CDN base path for "w185" width poster thumbnails
const IMG_W185 = "https://image.tmdb.org/t/p/w185";

// How strongly each star rating adjusts per-genre scores (multiplied by rating minus neutral 3)
const LEARN_PER_GENRE = 0.85;
// Ignore TMDB results with very few votes to reduce junk recommendations
const MIN_VOTE_COUNT = 40;

// JSDoc: describes a normalized movie object used in the popup logic
/** @typedef {{ id: number, title: string, poster_path: string | null, genre_ids: number[], overview: string, release_date?: string, vote_average?: number, vote_count?: number }} MovieLite */

// Opens the extension's options page where the API key is stored (fallback opens options.html in a tab)
function openOptionsPage() {
  // Prefer the Chrome API that opens the registered options page in a tab
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    // Older/alternate environments: open options.html via extension URL
    window.open(chrome.runtime.getURL("options.html"));
  }
}

// Loads the TMDB API key from local storage and returns a trimmed string (or empty)
async function getApiKey() {
  // Read one or more keys; we only ask for STORAGE_KEY
  const data = await chrome.storage.local.get(STORAGE_KEY);
  // Return stored value or empty string, with whitespace removed
  return (data[STORAGE_KEY] || "").trim();
}

// Loads persisted session or returns a fresh default object with empty arrays/maps
async function loadSession() {
  // Fetch the blob stored under SESSION_KEY
  const data = await chrome.storage.local.get(SESSION_KEY);
  // Use saved session or default structure for first run
  return (
    data[SESSION_KEY] || {
      favorites: [], // user's three chosen films (with genres, etc.)
      genreAffinity: {}, // string genre id -> learned weight from ratings
      rated: [], // list of { id, title, rating, genre_ids } for each rated suggestion
      usedIds: [], // movie ids already shown so we do not repeat them
      current: null, // the movie currently on screen waiting for a rating
    }
  );
}

// Writes the entire session object back to chrome.storage.local
async function saveSession(session) {
  // Persist under SESSION_KEY so the next popup open can restore state
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

/**
 * Low-level TMDB GET: builds URL with api_key and optional query, parses JSON or throws
 * @param {string} key TMDB API key
 * @param {string} path API path starting with /
 * @param {Record<string, string>} [query] extra query parameters
 */
async function tmdb(key, path, query = {}) {
  // Merge api_key with caller query params into a URLSearchParams instance
  const params = new URLSearchParams({ api_key: key, ...query });
  // Full request URL for this endpoint
  const url = `${TMDB_BASE}${path}?${params}`;
  // Perform the HTTP GET
  const res = await fetch(url);
  // Non-2xx responses become errors with body text when possible
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `TMDB ${res.status}`);
  }
  // Parse JSON body as the API response object
  return res.json();
}

/**
 * Fetches one movie by id and maps TMDB fields into our MovieLite shape (including genre ids)
 * @param {string} key TMDB API key
 * @param {number} id TMDB movie id
 * @returns {Promise<MovieLite>}
 */
async function fetchMovieDetails(key, id) {
  // GET /movie/{id} returns title, genres array, overview, etc.
  const data = await tmdb(key, `/movie/${id}`);
  // Return a consistent object the rest of the code expects
  return {
    id: data.id, // numeric TMDB id
    title: data.title, // display title
    poster_path: data.poster_path, // path segment for image CDN or null
    genre_ids: (data.genres || []).map((g) => g.id), // flatten genres to id list
    overview: data.overview || "", // plot summary, default empty
    release_date: data.release_date, // ISO date string or undefined
    vote_average: data.vote_average, // TMDB average rating
    vote_count: data.vote_count, // how many votes contributed
  };
}

/**
 * Search movies by title query; returns empty array for blank query
 * @param {string} key TMDB API key
 * @param {string} q user-typed search string
 */
async function searchMovies(key, q) {
  // Avoid calling the API for whitespace-only input
  if (!q.trim()) return [];
  // TMDB search endpoint returns results array
  const data = await tmdb(key, "/search/movie", { query: q.trim() });
  // TMDB may omit results; default to empty array
  return data.results || [];
}

/**
 * First page of movies TMDB considers similar to the given movie id
 * @param {string} key TMDB API key
 * @param {number} movieId TMDB movie id
 */
async function fetchSimilar(key, movieId) {
  // Similar movies endpoint, page 1 only for speed
  const data = await tmdb(key, `/movie/${movieId}/similar`, { page: "1" });
  // Array of partial movie objects
  return data.results || [];
}

/**
 * Discover movies filtered by genre ids (pipe-separated OR list) and page index
 * @param {string} key TMDB API key
 * @param {string} genreParam e.g. "28|12"
 * @param {number} page 1-based page number
 */
async function discoverByGenres(key, genreParam, page) {
  // TMDB discover with minimum votes and sort by average rating descending
  const data = await tmdb(key, "/discover/movie", {
    with_genres: genreParam, // OR of genre ids
    sort_by: "vote_average.desc", // prefer highly rated among matches
    "vote_count.gte": String(MIN_VOTE_COUNT), // filter out obscure titles
    page: String(page), // pagination
  });
  return data.results || [];
}

/**
 * Broad discover by global popularity when genre pool is too small
 * @param {string} key TMDB API key
 * @param {number} page 1-based page number
 */
async function discoverPopular(key, page) {
  // Sort by popularity as a fallback source of candidates
  const data = await tmdb(key, "/discover/movie", {
    sort_by: "popularity.desc", // trending / popular ordering
    "vote_count.gte": String(MIN_VOTE_COUNT), // still require minimum votes
    page: String(page),
  });
  return data.results || [];
}

/**
 * Collects unique genre ids that appear on any of the user's favourite movies
 * @param {MovieLite[]} favourites array of three (or fewer) favourite MovieLite objects
 */
function favoriteGenreIds(favorites) {
  // Set ensures each genre id is counted once
  const set = new Set();
  // Walk every favourite
  for (const f of favorites) {
    // Add each genre id from this favourite
    for (const g of f.genre_ids || []) set.add(g);
  }
  // Convert set to array for TMDB query strings and iteration
  return [...set];
}

/**
 * Partial score from learned genre weights plus a bonus if genre matches favourite genres
 * @param {Record<string, number>} affinity genre id string -> weight
 * @param {number[]} genreIds genres on the candidate movie
 * @param {Set<number>} favGenres genre ids from the user's three favourites
 */
function scoreMovie(affinity, genreIds, favGenres) {
  // Accumulator for the linear model score
  let s = 0;
  // Each genre on the candidate contributes
  for (const g of genreIds) {
    // Storage keys are strings
    const k = String(g);
    // Add learned affinity if we have history for this genre
    if (affinity[k] != null) s += affinity[k];
    // Small boost if this genre also appears in the user's stated favourites
    if (favGenres.has(g)) s += 1.2;
  }
  return s;
}

/**
 * Builds a deduplicated list of candidate movies from similar + discover + popular fallbacks
 * @param {string} key TMDB API key
 * @param {Awaited<ReturnType<typeof loadSession>>} session current session with favourites and exclusions
 */
async function collectCandidates(key, session) {
  /** @type {Map<number, MovieLite>} */
  // Map from movie id -> normalized MovieLite to avoid duplicates
  const map = new Map();
  // Quick lookup of favourite movie ids
  const favIds = new Set(session.favorites.map((f) => f.id));
  // Never recommend favourites, already-rated, or already-used ids again
  const blocked = new Set([...favIds, ...session.rated.map((r) => r.id), ...session.usedIds]);

  // For each favourite, pull TMDB "similar" titles
  for (const f of session.favorites) {
    try {
      const sim = await fetchSimilar(key, f.id);
      // Each similar result is a candidate if it passes filters
      for (const m of sim) {
        // Skip invalid or blocked ids
        if (!m.id || blocked.has(m.id)) continue;
        // Skip low-vote noise
        if ((m.vote_count || 0) < MIN_VOTE_COUNT) continue;
        // First time we see this id, store a normalized shape
        if (!map.has(m.id)) {
          map.set(m.id, {
            id: m.id,
            title: m.title,
            poster_path: m.poster_path,
            genre_ids: m.genre_ids || [],
            overview: m.overview || "",
            release_date: m.release_date,
            vote_average: m.vote_average,
            vote_count: m.vote_count,
          });
        }
      }
    } catch {
      /* ignore per-favourite network or API failure */
    }
  }

  // Union of all genre ids from favourites, as OR filter for discover
  const favGenreList = favoriteGenreIds(session.favorites);
  // TMDB expects pipe-separated ids for OR semantics
  const genreParam = favGenreList.join("|");
  // Only call discover if we have at least one genre
  if (genreParam) {
    // Up to three pages of discover to widen the pool
    for (let p = 1; p <= 3; p++) {
      try {
        const disc = await discoverByGenres(key, genreParam, p);
        for (const m of disc) {
          if (!m.id || blocked.has(m.id)) continue;
          if ((m.vote_count || 0) < MIN_VOTE_COUNT) continue;
          if (!map.has(m.id)) {
            map.set(m.id, {
              id: m.id,
              title: m.title,
              poster_path: m.poster_path,
              genre_ids: m.genre_ids || [],
              overview: m.overview || "",
              release_date: m.release_date,
              vote_average: m.vote_average,
              vote_count: m.vote_count,
            });
          }
        }
      } catch {
        // Stop paging this source on error
        break;
      }
    }
  }

  // If the pool is still tiny, add popular global titles
  if (map.size < 8) {
    // Two pages of popularity-sorted discover
    for (let p = 1; p <= 2; p++) {
      try {
        const pop = await discoverPopular(key, p);
        for (const m of pop) {
          if (!m.id || blocked.has(m.id)) continue;
          if ((m.vote_count || 0) < MIN_VOTE_COUNT) continue;
          if (!map.has(m.id)) {
            map.set(m.id, {
              id: m.id,
              title: m.title,
              poster_path: m.poster_path,
              genre_ids: m.genre_ids || [],
              overview: m.overview || "",
              release_date: m.release_date,
              vote_average: m.vote_average,
              vote_count: m.vote_count,
            });
          }
        }
      } catch {
        break;
      }
    }
  }

  // Return all unique candidates as an array
  return [...map.values()];
}

/**
 * Chooses the single highest-scoring candidate using affinity, favourite overlap, and TMDB stats
 * @param {Awaited<ReturnType<typeof loadSession>>} session session with favourites and genreAffinity
 * @param {MovieLite[]} candidates non-empty list ideally; may be empty
 */
function pickBest(session, candidates) {
  // Set of genre ids from favourites for overlap bonus inside scoreMovie
  const favGenres = new Set(favoriteGenreIds(session.favorites));
  // Shorthand for learned weights (may be empty object)
  const affinity = session.genreAffinity || {};

  // Track best movie seen so far
  let best = null;
  // Track best numeric score (start at negative infinity so any real score wins)
  let bestScore = -Infinity;

  // Score every candidate and keep the max
  for (const m of candidates) {
    // Base score from genres + favourite overlap
    const base = scoreMovie(affinity, m.genre_ids || [], favGenres);
    // Small tie-breaker from TMDB quality signals (log vote count dampens huge counts)
    const tie = (m.vote_average || 0) * 0.15 + Math.log10((m.vote_count || 1) + 1) * 0.08;
    const s = base + tie;
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best;
}

/**
 * Updates genreAffinity from a 1–5 rating: 3 is neutral, 5 pulls genres up, 1 pushes down
 * @param {Awaited<ReturnType<typeof loadSession>>} session session object to mutate
 * @param {number} rating user rating 1–5
 * @param {MovieLite} movie the rated movie (genres drive the update)
 */
function applyRatingToAffinity(session, rating, movie) {
  // Signed shift per genre: (rating - 3) * LEARN_PER_GENRE
  const delta = (rating - 3) * LEARN_PER_GENRE;
  // Clone existing map so we do not mutate a shared reference oddly
  const ga = { ...session.genreAffinity };
  // Apply delta to every genre on this movie
  for (const g of movie.genre_ids || []) {
    const k = String(g);
    ga[k] = (ga[k] || 0) + delta;
  }
  // Write back onto the session
  session.genreAffinity = ga;
}

// Adds positive prior weights for genres present on the user's three favourites before any ratings
function seedAffinityFromFavorites(session) {
  // Start from current affinity map (usually empty on fresh start)
  const ga = { ...session.genreAffinity };
  // Every favourite film
  for (const f of session.favorites) {
    // Every genre on that film gets a mild positive bias
    for (const g of f.genre_ids || []) {
      const k = String(g);
      ga[k] = (ga[k] || 0) + 1.1;
    }
  }
  session.genreAffinity = ga;
}

// --- UI helpers and event wiring ---

// Short alias to get a DOM node by id (throws if missing; ids are static in popup.html)
const el = (id) => document.getElementById(id);

// Shows one of the main sections (noKey, setup, recommend, loading) and hides the others
function showSection(name) {
  // Fixed list of section element ids in popup.html
  const sections = ["noKey", "setup", "recommend", "loading"];
  // Toggle CSS hidden class so exactly one panel is visible
  for (const s of sections) {
    el(s).classList.toggle("hidden", s !== name);
  }
}

/** @type {{ slot: number, movie: MovieLite | null }[]} */
// In-memory picks for the three search slots before "Start recommendations" persists them
let picks = [
  { slot: 0, movie: null },
  { slot: 1, movie: null },
  { slot: 2, movie: null },
];

// Debounce timer handles per search slot (indexed 0,1,2)
let searchTimers = [null, null, null];
// In-memory pointer to the active session object (kept in sync with storage)
let sessionRef = null;
// Cached API key after init for TMDB calls that run before async storage reads complete
let apiKeyRef = "";

// Enables "Start recommendations" only when all three slots have a chosen movie
function updateStartButton() {
  // True only if every slot has a non-null movie object
  const filled = picks.every((p) => p.movie != null);
  // Disable the button until the user completes all three picks
  el("startRecs").disabled = !filled;
}

// After a movie is chosen for a slot, show confirmation and lock the input
function renderPicked(slot) {
  // The pick record for this slot index
  const p = picks[slot];
  // The green confirmation box under the input
  const box = document.querySelector(`[data-picked="${slot}"]`);
  // The text field for that slot
  const input = document.querySelector(`.fav-input[data-slot="${slot}"]`);
  // Abort if DOM is missing (should not happen in popup)
  if (!box || !input) return;
  if (p.movie) {
    // Show title with a checkmark
    box.textContent = `✓ ${p.movie.title}`;
    box.classList.remove("hidden");
    // Mirror title into input and prevent further edits
    input.value = p.movie.title;
    input.disabled = true;
  } else {
    // Hide confirmation and allow typing again
    box.classList.add("hidden");
    input.disabled = false;
  }
  // Re-evaluate whether Start can be pressed
  updateStartButton();
}

// Called when the user picks a row from the search dropdown for one slot
async function onSelectSearchResult(slot, movie) {
  try {
    // Always read key from storage so it works even if popup opened before key was set
    const key = await getApiKey();
    if (!key) return;
    // Load full details (genres especially) for the selected search result
    const full = await fetchMovieDetails(key, movie.id);
    // Clear any previous setup error message
    const st = el("setupStatus");
    if (st) {
      st.textContent = "";
      st.classList.add("hidden");
    }
    // Store the full MovieLite in the slot
    picks[slot].movie = full;
    // Hide the suggestion list for this slot
    document.querySelector(`[data-slot="${slot}"].suggest`)?.classList.add("hidden");
    // Update the UI for this slot
    renderPicked(slot);
  } catch (e) {
    console.error(e);
    // Show a visible error in the setup card
    const st = el("setupStatus");
    if (st) {
      st.textContent = "Could not load that title. Try another.";
      st.classList.remove("hidden");
    }
  }
}

// Attaches input/blur handlers for one favourite search slot
function wireSearch(slot) {
  // The text input for this slot
  const input = document.querySelector(`.fav-input[data-slot="${slot}"]`);
  // The dropdown ul for suggestions
  const list = document.querySelector(`.suggest[data-slot="${slot}"]`);
  if (!input || !list) return;

  // Fire on every keystroke (debounced inside)
  input.addEventListener("input", () => {
    // Do not search if user already locked a movie for this slot
    if (picks[slot].movie) return;
    // Current input string
    const q = input.value;
    // Cancel any pending debounced search for this slot
    if (searchTimers[slot]) clearTimeout(searchTimers[slot]);
    // Debounce network calls to TMDB search
    searchTimers[slot] = setTimeout(async () => {
      if (!q.trim()) {
        list.classList.add("hidden");
        list.innerHTML = "";
        return;
      }
      try {
        const key = await getApiKey();
        if (!key) return;
        const results = await searchMovies(key, q);
        list.innerHTML = "";
        // Show up to eight results
        for (const r of results.slice(0, 8)) {
          const li = document.createElement("li");
          const y = (r.release_date || "").slice(0, 4);
          li.textContent = y ? `${r.title} (${y})` : r.title;
          // mousedown fires before blur so selection works before list hides
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            onSelectSearchResult(slot, r);
          });
          list.appendChild(li);
        }
        list.classList.toggle("hidden", results.length === 0);
      } catch (e) {
        console.error(e);
        list.classList.add("hidden");
      }
    }, 320);
  });

  // Hide suggestions shortly after focus leaves the field
  input.addEventListener("blur", () => {
    setTimeout(() => list.classList.add("hidden"), 200);
  });
}

// Fills the recommendation panel with title, year, overview, and poster image
function displayRecommendation(m) {
  el("recTitle").textContent = m.title;
  const y = (m.release_date || "").slice(0, 4);
  el("recYear").textContent = y || "";
  el("recOverview").textContent = m.overview || "No overview available.";
  const img = el("recPoster");
  if (m.poster_path) {
    img.src = `${IMG_W185}${m.poster_path}`;
    img.alt = `Poster: ${m.title}`;
    img.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.alt = "";
    img.classList.add("hidden");
  }
  el("recStatus").textContent = "";
}

// Computes and shows the next recommendation, or an error/empty state
async function nextRecommendation() {
  showSection("loading");
  const session = sessionRef;
  const key = apiKeyRef;
  try {
    const candidates = await collectCandidates(key, session);
    const best = pickBest(session, candidates);
    if (!best) {
      showSection("recommend");
      el("recTitle").textContent = "Nothing left in the pool";
      el("recYear").textContent = "";
      el("recOverview").textContent =
        "Try Reset session or different favourites. Check your connection and API key.";
      el("recPoster").classList.add("hidden");
      return;
    }
    let detail = best;
    if (!best.genre_ids || best.genre_ids.length === 0) {
      detail = await fetchMovieDetails(key, best.id);
    }
    session.current = detail;
    await saveSession(session);
    showSection("recommend");
    displayRecommendation(detail);
  } catch (e) {
    console.error(e);
    showSection("recommend");
    el("recStatus").textContent = "Request failed. Check API key and try again.";
  }
}

// One-time setup: listeners first, then restore session or show appropriate panel
async function init() {
  document.getElementById("openOptions")?.addEventListener("click", (e) => {
    e.preventDefault();
    openOptionsPage();
  });
  document.getElementById("goOptions")?.addEventListener("click", () => openOptionsPage());

  el("startRecs").addEventListener("click", async () => {
    const session = await loadSession();
    session.favorites = picks.map((p) => ({
      id: p.movie.id,
      title: p.movie.title,
      poster_path: p.movie.poster_path,
      genre_ids: p.movie.genre_ids,
      overview: p.movie.overview,
      release_date: p.movie.release_date,
    }));
    session.rated = [];
    session.usedIds = [];
    session.genreAffinity = {};
    seedAffinityFromFavorites(session);
    session.current = null;
    sessionRef = session;
    await saveSession(session);
    el("setup").classList.add("hidden");
    await nextRecommendation();
  });

  document.querySelectorAll(".star-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rating = Number(btn.getAttribute("data-rating"));
      const session = await loadSession();
      const cur = session.current;
      if (!cur) return;

      session.rated.push({
        id: cur.id,
        title: cur.title,
        rating,
        genre_ids: cur.genre_ids || [],
      });
      session.usedIds.push(cur.id);
      applyRatingToAffinity(session, rating, cur);
      session.current = null;
      sessionRef = session;
      await saveSession(session);
      await nextRecommendation();
    });
  });

  el("resetAll").addEventListener("click", async () => {
    await chrome.storage.local.remove(SESSION_KEY);
    sessionRef = await loadSession();
    picks = [
      { slot: 0, movie: null },
      { slot: 1, movie: null },
      { slot: 2, movie: null },
    ];
    document.querySelectorAll(".fav-input").forEach((inp) => {
      inp.value = "";
      inp.disabled = false;
    });
    document.querySelectorAll(".picked").forEach((p) => p.classList.add("hidden"));
    el("setup").classList.remove("hidden");
    showSection("setup");
    updateStartButton();
  });

  const key = await getApiKey();
  apiKeyRef = key;
  if (!key) {
    showSection("noKey");
    return;
  }

  for (let i = 0; i < 3; i++) wireSearch(i);

  sessionRef = await loadSession();

  if (sessionRef.favorites?.length === 3 && sessionRef.current) {
    picks = sessionRef.favorites.map((f, i) => ({
      slot: i,
      movie: {
        id: f.id,
        title: f.title,
        poster_path: f.poster_path,
        genre_ids: f.genre_ids,
        overview: f.overview || "",
        release_date: f.release_date,
      },
    }));
    for (let i = 0; i < 3; i++) renderPicked(i);
    el("setup").classList.add("hidden");
    showSection("recommend");
    displayRecommendation(sessionRef.current);
    return;
  }

  if (sessionRef.favorites?.length === 3) {
    picks = sessionRef.favorites.map((f, i) => ({
      slot: i,
      movie: {
        id: f.id,
        title: f.title,
        poster_path: f.poster_path,
        genre_ids: f.genre_ids,
        overview: f.overview || "",
        release_date: f.release_date,
      },
    }));
    for (let i = 0; i < 3; i++) renderPicked(i);
    updateStartButton();
    el("setup").classList.add("hidden");
    await nextRecommendation();
    return;
  }

  showSection("setup");
}

// Start the popup logic when the script loads
init();
