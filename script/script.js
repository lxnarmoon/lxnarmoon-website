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

function sortLevels(levels, sortKey) {
    const { read, direction } = SORTS[sortKey] ?? SORTS[DEFAULT_SORT];
    const factor = direction === 'asc' ? 1 : -1;

    // Array.prototype.sort is stable, so equal values keep their order from the index file.
    return [...levels].sort((a, b) => {
        const left = read(a);
        const right = read(b);

        // Levels missing the value go to the bottom in either direction.
        if (left === null && right === null) return 0;
        if (left === null) return 1;
        if (right === null) return -1;

        return (left - right) * factor;
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

function buildVideoSection(item) {
    const id = getYouTubeId(item.video);
    if (!id) return '';

    return `
            <section class="preview-video">
                <div class="video-frame">
                    <iframe
                        src="https://www.youtube-nocookie.com/embed/${id}"
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

/* ---------- Stats (attempts / worst fail only render if present) ---------- */

function buildStats(item) {
    const stats = [
        `<div class="stat">
                    <dt>Personal Difficulty</dt>
                    <dd class="stat-accent">${escapeHTML(item.diffRating)}</dd>
                </div>`,
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
