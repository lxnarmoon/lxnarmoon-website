let selectedItem = null;

// Every page that uses the ranking layout. Each one loads data/_<page>.json
const RANKING_PAGES = ['edl', 'mdl', 'hdl', 'idl'];

// Overall score = gameplay 70% + deco 20% + song 10%
// Weights are out of 10 (integers) so the rounding stays exact.
const SCORE_WEIGHTS = { gameplay: 7, deco: 2, song: 1 };
const SCORE_LABELS = { gameplay: 'Gameplay', deco: 'Deco', song: 'Song' };

// Highest threshold first. Anything under 10 is still shown as F.
const GRADES = [
    { grade: 'SS', min: 97 },
    { grade: 'S', min: 90 },
    { grade: 'A', min: 80 },
    { grade: 'B', min: 65 },
    { grade: 'C', min: 50 },
    { grade: 'D', min: 30 },
    { grade: 'F', min: 10 }
];

// Difficulty tiers, in order: the whole number of a rating picks the tier (14.15 -> tier 14).
// Colors are the hex codes from the original spreadsheet.
const DIFFICULTY_TIERS = [
    { name: 'Insane Demon', color: '#1155cc' },  // 1.XX
    { name: 'Beginner', color: '#4a86e8' },      // 2.XX
    { name: 'Easy', color: '#00ffff' },          // 3.XX
    { name: 'Medium', color: '#00ff00' },        // 4.XX
    { name: 'Hard', color: '#ffff00' },          // 5.XX
    { name: 'Very Hard', color: '#ff9900' },     // 6.XX
    { name: 'Insane', color: '#ff0000' },        // 7.XX
    { name: 'Extreme', color: '#ff00ff' },       // 8.XX
    { name: 'Remorseless', color: '#9900ff' },   // 9.XX
    { name: 'Relentless', color: '#b087eb' },    // 10.XX
    { name: 'Terrifying', color: '#f19eea' },    // 11.XX
    { name: 'Catastrophic', color: '#ea6661' },  // 12.XX
    { name: 'Inexorable', color: '#ffc183' },    // 13.XX
    { name: 'Excruciating', color: '#ffe599' },  // 14.XX
    { name: 'Merciless', color: '#a7e58d' },     // 15.XX
    { name: 'Monstrous', color: '#5bad96' },     // 16.XX
    { name: 'Apocalyptic', color: '#528cb1' },   // 17.XX
    { name: 'Demonic', color: '#6d6ab0' },       // 18.XX
    { name: 'Menacing', color: '#9452a2' },      // 19.XX
    { name: 'Unreal', color: '#913869' },        // 20.XX
    { name: 'Nightmare', color: '#832828' }      // 21.XX
];

// How far a rating can drift toward the next tier's color, from 0 to 1.
// A rating's color starts as its own tier's color at X.00 and moves toward the next tier
// as the decimals grow, but only up to this share by X.99. At 0.4, 12.97 is about 40%
// Inexorable and 60% Catastrophic, so it still reads as Catastrophic. Raise it for a
// stronger gradient, lower it to keep every tier closer to its own color. 0 turns blending
// off, and 1 blends all the way (X.99 looks like the next tier).
const DIFFICULTY_BLEND = 0.4;

// Placement inside a tier, from the two decimals of the rating (14.15 -> 15).
// Highest threshold first.
const PLACEMENTS = [
    { name: 'Peak', min: 89 },        // X.89 - X.99
    { name: 'High-Peak', min: 78 },   // X.78 - X.88
    { name: 'High', min: 67 },        // X.67 - X.77
    { name: 'Mid-High', min: 56 },    // X.56 - X.66
    { name: 'Mid', min: 45 },         // X.45 - X.55
    { name: 'Low-Mid', min: 34 },     // X.34 - X.44
    { name: 'Low', min: 23 },         // X.23 - X.33
    { name: 'Bottom-Low', min: 12 },  // X.12 - X.22
    { name: 'Bottom', min: 1 },       // X.01 - X.11
    { name: 'Baseline', min: 0 }      // X.00
];

document.addEventListener('DOMContentLoaded', () => {
    const pageType = document.body.getAttribute('data-page');
    if (RANKING_PAGES.includes(pageType)) {
        initRankingPage(pageType);
    }
});

/* ---------- Helpers ---------- */

function escapeHTML(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
}

function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/* ---------- Overall score ---------- */

function calculateScore(item) {
    const keys = Object.keys(SCORE_WEIGHTS);
    if (!keys.every(key => isNumber(item[key]))) return null;

    // `exact` keeps the decimals so sorting by score doesn't lose ties to rounding
    const exact = keys.reduce((sum, key) => sum + item[key] * SCORE_WEIGHTS[key], 0) / 10;
    const total = Math.round(exact);
    const entry = GRADES.find(g => total >= g.min) ?? GRADES[GRADES.length - 1];

    return { total, exact, grade: entry.grade };
}

/* ---------- Sorting ---------- */

// diffRating is stored as text ("14.15") so trailing zeros survive, so it is parsed here.
function getDifficulty(item) {
    const value = typeof item.diffRating === 'string' ? Number.parseFloat(item.diffRating) : item.diffRating;
    return isNumber(value) ? value : null;
}

function getScore(item) {
    return calculateScore(item)?.exact ?? null;
}

function getAttempts(item) {
    return isNumber(item.attempts) ? item.attempts : null;
}

// Keys match the <option value> entries in the page's #sort-select.
const SORTS = {
    'difficulty-desc': { read: getDifficulty, direction: 'desc' },
    'difficulty-asc': { read: getDifficulty, direction: 'asc' },
    'score-desc': { read: getScore, direction: 'desc' },
    'score-asc': { read: getScore, direction: 'asc' },
    'attempts-desc': { read: getAttempts, direction: 'desc' },
    'attempts-asc': { read: getAttempts, direction: 'asc' }
};

const DEFAULT_SORT = 'difficulty-desc';

// The rank badge always shows a level's place in this order, whatever the list is
// currently sorted by, so "#3" means the same thing in every view.
const RANK_SORT = 'difficulty-desc';

const NAME_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' });

function sortLevels(levels, sortKey) {
    const { read, direction } = SORTS[sortKey] ?? SORTS[DEFAULT_SORT];
    const factor = direction === 'asc' ? 1 : -1;

    // Equal values are ordered A-Z by name (ignoring capitals), in every sort and direction.
    // The Discord announcement in worker/add-level-worker.js uses the same rule.
    const byName = (a, b) => NAME_COLLATOR.compare(String(a.name ?? ''), String(b.name ?? ''));

    return [...levels].sort((a, b) => {
        const left = read(a);
        const right = read(b);

        // Levels missing the value go to the bottom in either direction.
        if (left === null && right === null) return byName(a, b);
        if (left === null) return 1;
        if (right === null) return -1;

        return (left - right) * factor || byName(a, b);
    });
}

function buildRankMap(levels) {
    return new Map(sortLevels(levels, RANK_SORT).map((item, index) => [item, index + 1]));
}

/* ---------- Loading ---------- */

async function fetchLevel(file) {
    // Entries may be written as "chimera" or "chimera.json"
    const path = file.endsWith('.json') ? file : `${file}.json`;
    const response = await fetch(`../data/${path}`);
    if (!response.ok) throw new Error(`Could not load level file: ${path}`);
    return response.json();
}

async function initRankingPage(type) {
    const listFile = `../data/_${type}.json`;

    try {
        const response = await fetch(listFile);
        if (!response.ok) throw new Error(`Could not locate index list: ${listFile}`);

        const fileNames = await response.json();

        // One missing or broken level file shouldn't take the whole list down.
        const results = await Promise.allSettled(fileNames.map(fetchLevel));
        const levelsData = [];
        results.forEach(result => {
            if (result.status === 'fulfilled') {
                levelsData.push(result.value);
            } else {
                console.warn(result.reason);
            }
        });

        const listContainer = document.getElementById('ranking-list');
        const sortSelect = document.getElementById('sort-select');
        const searchInput = document.getElementById('level-search');

        const ranks = buildRankMap(levelsData);
        // Read the select, not the default: browsers can restore a previous choice on reload.
        let sortKey = sortSelect && SORTS[sortSelect.value] ? sortSelect.value : DEFAULT_SORT;
        let searchQuery = '';

        const refreshList = () => renderList(levelsData, ranks, listContainer, sortKey, searchQuery);

        refreshList();

        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                sortKey = e.target.value;
                refreshList();
            });
        }

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                refreshList();
            });
        }

    } catch (error) {
        console.error("Initialization Error:", error);
    }
}

/* ---------- Comments ---------- */

function buildCommentsSection(item) {
    const text = typeof item.comments === 'string' ? item.comments.trim() : '';
    if (!text) return '';

    return `
            <section class="preview-comments">
                <h3 class="preview-label">Comments</h3>
                <p>${escapeHTML(text)}</p>
            </section>`;
}

/* ---------- Video ---------- */

// Accepts watch?v=, youtu.be/, /shorts/, /embed/ and /live/ links.
// Returns the 11-character video ID, or null if the link isn't usable.
function getYouTubeId(url) {
    if (typeof url !== 'string') return null;

    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    const host = parsed.hostname.replace(/^(www|m)\./, '');
    let id = null;

    if (host === 'youtu.be') {
        id = parsed.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (parsed.pathname === '/watch') {
            id = parsed.searchParams.get('v');
        } else {
            const match = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/);
            if (match) id = match[1];
        }
    }

    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// Reads the timestamp from a link and returns it in whole seconds, or null when there isn't one.
// Understands t=268, t=268s, t=4m28s, t=1h2m3s, start=268 and #t=268.
function getYouTubeStart(url) {
    if (typeof url !== 'string') return null;

    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const raw = parsed.searchParams.get('t') ?? parsed.searchParams.get('start') ?? hash.get('t');
    const match = typeof raw === 'string' ? raw.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i) : null;
    if (!match) return null;

    const [, hours = 0, minutes = 0, seconds = 0] = match;
    const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    return total > 0 && total <= 359999 ? total : null;
}

function buildVideoSection(item) {
    const id = getYouTubeId(item.video);
    if (!id) return '';

    const start = getYouTubeStart(item.video);
    const embedUrl = `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`;

    return `
            <section class="preview-video">
                <div class="video-frame">
                    <iframe
                        src="${embedUrl}"
                        title="${escapeHTML(item.name)} video"
                        loading="lazy"
                        referrerpolicy="strict-origin-when-cross-origin"
                        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowfullscreen></iframe>
                </div>
            </section>`;
}

/* ---------- Score card ---------- */

function buildScoreSection(item) {
    const score = calculateScore(item);
    if (!score) return '';

    const breakdown = Object.keys(SCORE_WEIGHTS).map(key => `
                    <div class="score-part">
                        <dt>${SCORE_LABELS[key]} <span class="score-weight">${SCORE_WEIGHTS[key] * 10}%</span></dt>
                        <dd>${escapeHTML(item[key])}</dd>
                    </div>`).join('');

    return `
            <section class="preview-score" aria-label="Overall score">
                <div class="score-overall">
                    <span class="score-grade" data-grade="${score.grade}" aria-label="Grade ${score.grade}">${score.grade}</span>
                    <div>
                        <h3 class="preview-label">Overall score</h3>
                        <p class="score-number">${score.total}<span class="score-max">/100</span></p>
                    </div>
                </div>
                <dl class="score-breakdown">${breakdown}
                </dl>
            </section>`;
}

/* ---------- Personal difficulty: tier name, placement and gradient color ---------- */

function hexToRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb) {
    return '#' + rgb.map(part => part.toString(16).padStart(2, '0')).join('');
}

// Blend two colors; amount 0 gives `from`, 1 gives `to`.
function mixColors(from, to, amount) {
    const start = hexToRgb(from);
    const end = hexToRgb(to);
    return rgbToHex(start.map((part, i) => Math.round(part + (end[i] - part) * amount)));
}

// Black or white text, whichever reads better on the given background (WCAG contrast).
function readableInk(background) {
    const [r, g, b] = hexToRgb(background).map(part => {
        const channel = part / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const againstWhite = 1.05 / (luminance + 0.05);
    const againstBlack = (luminance + 0.05) / 0.05;
    return againstBlack >= againstWhite ? '#000000' : '#ffffff';
}

// Reads a rating like "14.15" (text or number). The placement comes from the first two
// decimals, read as text so 14.1 is .10 and floating point never moves a boundary.
function parseRating(raw) {
    const text = String(raw ?? '').trim();
    const match = text.match(/^(\d{1,3})(?:\.(\d+))?$/);
    if (!match) return null;

    const whole = Number(match[1]);
    const hundredths = Number((match[2] ?? '').padEnd(2, '0').slice(0, 2));
    return { text, whole, hundredths, value: Number(text) };
}

// Everything the page needs to show a rating. Ratings outside 1.00-21.99 still display,
// just without a tier name or color.
function describeDifficulty(raw) {
    const rating = parseRating(raw);
    if (!rating) return { text: String(raw ?? ''), label: String(raw ?? ''), color: null, ink: null };

    const tier = DIFFICULTY_TIERS[rating.whole - 1];
    if (!tier) return { text: rating.text, label: rating.text, color: null, ink: null };

    const placement = PLACEMENTS.find(entry => rating.hundredths >= entry.min);

    // Drift toward the next tier as the decimals grow, capped by DIFFICULTY_BLEND.
    // Past the last tier there is nothing to drift toward.
    const next = DIFFICULTY_TIERS[rating.whole];
    const color = next
        ? mixColors(tier.color, next.color, (rating.value - rating.whole) * DIFFICULTY_BLEND)
        : tier.color;

    return {
        text: rating.text,
        label: `${rating.text} (${placement.name} ${tier.name})`,
        color,
        ink: readableInk(color)
    };
}

function buildDifficultyStat(item) {
    const difficulty = describeDifficulty(item.diffRating);

    // The colors come from the code above, never from the data file, so they are safe in style=""
    const value = difficulty.color
        ? `<span class="difficulty-badge" style="--tier-bg: ${difficulty.color}; --tier-ink: ${difficulty.ink}">${escapeHTML(difficulty.label)}</span>`
        : escapeHTML(difficulty.label);

    return `<div class="stat stat-difficulty">
                    <dt>Personal Difficulty</dt>
                    <dd${difficulty.color ? '' : ' class="stat-accent"'}>${value}</dd>
                </div>`;
}

/* ---------- Stats (attempts / worst fail only render if present) ---------- */

function buildStats(item) {
    const stats = [
        buildDifficultyStat(item),
        `<div class="stat">
                    <dt>Level ID</dt>
                    <dd>${escapeHTML(item.id)}</dd>
                </div>`
    ];

    if (isNumber(item.attempts)) {
        stats.push(`<div class="stat">
                    <dt>Attempts</dt>
                    <dd>${item.attempts.toLocaleString()}</dd>
                </div>`);
    }

    if (isNumber(item.worstFail)) {
        stats.push(`<div class="stat">
                    <dt>Worst Fail</dt>
                    <dd>${Math.round(item.worstFail)}%</dd>
                </div>`);
    }

    return stats.join('\n                ');
}

/* ---------- List ---------- */

function renderList(levels, ranks, container, sortKey, query = '') {
    container.innerHTML = '';
    let shown = 0;
    const needle = normalizeText(query);

    sortLevels(levels, sortKey).forEach(item => {
        if (needle && !normalizeText(item.name).includes(needle)) {
            return;
        }
        shown++;

        const rank = ranks.get(item);
        const rankDisplay = `#${rank}`;
        const rankLabel = `Rank ${rank}`;

        const li = document.createElement('li');
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'ranking-item';
        if (item === selectedItem) button.setAttribute('aria-current', 'true');

        button.innerHTML = `
            <span class="rank-badge" aria-hidden="true">${rankDisplay}</span>
            <span class="sr-only">${rankLabel}:</span>
            <span class="level-name">${escapeHTML(item.name)}</span>
        `;

        button.addEventListener('click', () => {
            selectItem(item, rankDisplay, rankLabel, button, container);
        });

        li.appendChild(button);
        container.appendChild(li);
    });

    if (shown === 0) {
        const empty = document.createElement('li');
        empty.className = 'list-empty';
        empty.textContent = needle ? 'No levels match your search.' : 'No levels yet.';
        container.appendChild(empty);
    }

    const status = document.getElementById('results-status');
    if (status) {
        status.textContent = needle
            ? `Showing ${shown} of ${levels.length} levels`
            : '';
    }
}

function selectItem(item, rankDisplay, rankLabel, button, container) {
    selectedItem = item;

    container.querySelectorAll('.ranking-item[aria-current]').forEach(el => {
        el.removeAttribute('aria-current');
    });
    button.setAttribute('aria-current', 'true');

    updatePreview(item, rankDisplay, rankLabel);

    if (window.matchMedia('(max-width: 767px)').matches) {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById('preview-content')
            .scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
}

function updatePreview(item, rankDisplay, rankLabel) {
    const previewContainer = document.getElementById('preview-content');
    if (!previewContainer) return;

    previewContainer.innerHTML = `
        <article class="preview-card">
            <header class="preview-header">
                <h2 class="preview-title">
                    <span class="preview-rank" aria-hidden="true">${rankDisplay}</span>
                    <span class="sr-only">${rankLabel}:</span>${escapeHTML(item.name)}
                    <span class="preview-meta">${escapeHTML(item.creator)}</span>
                </h2>
            </header>
            ${buildCommentsSection(item)}
            ${buildVideoSection(item)}
            ${buildScoreSection(item)}
            <dl class="preview-stats">
                ${buildStats(item)}
            </dl>
        </article>
    `;
}
