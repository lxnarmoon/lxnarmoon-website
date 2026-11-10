let selectedItem = null;

const STATUS_MARKERS = {
    "Promoted": { symbol: "↑", label: "Promoted" },
    "Demoted": { symbol: "↓", label: "Demoted" },
    "Technicality": { symbol: "*", label: "Technicality" },
    "Not Demon": { symbol: "X", label: "Not Demon" }
};

const UNRANKED_STATUSES = ["Benchmark", "Not Demon", "Promoted", "Demoted", "Technicality"];

// Every page that uses the ranking layout. Each one loads data/_<page>.json
const RANKING_PAGES = ['edl', 'mdl', 'hdl', 'idl', 'aredl'];

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

function markerTitleAttr(item) {
    const marker = STATUS_MARKERS[item.promoted];
    return marker ? ` title="${marker.label}"` : '';
}

document.addEventListener('DOMContentLoaded', () => {
    const pageType = document.body.getAttribute('data-page');
    if (RANKING_PAGES.includes(pageType)) {
        initRankingPage(pageType);
    }
});

async function initRankingPage(type) {
    const listFile = `../data/_${type}.json`;

    try {
        const response = await fetch(listFile);
        if (!response.ok) throw new Error(`Could not locate index list: ${listFile}`);

        const fileNames = await response.json();

        // Entries may be written as "chimera" or "chimera.json"
        const fetchPromises = fileNames.map(file => {
            const path = file.endsWith('.json') ? file : `${file}.json`;
            return fetch(`../data/${path}`).then(res => res.json());
        });
        const levelsData = await Promise.all(fetchPromises);

        const listContainer = document.getElementById('ranking-list');
        const filterSelect = document.getElementById('status-filter');

        const searchInput = document.getElementById('level-search');
        let statusFilter = 'All';
        let searchQuery = '';

        const refreshList = () => renderList(levelsData, listContainer, statusFilter, searchQuery);

        refreshList();

        filterSelect.addEventListener('change', (e) => {
            statusFilter = e.target.value;
            refreshList();
        });

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
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
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

/* ---------- Overall score ---------- */

function calculateScore(item) {
    const keys = Object.keys(SCORE_WEIGHTS);
    if (!keys.every(key => isNumber(item[key]))) return null;

    const weighted = keys.reduce((sum, key) => sum + item[key] * SCORE_WEIGHTS[key], 0) / 10;
    const total = Math.round(weighted);
    const entry = GRADES.find(g => total >= g.min) ?? GRADES[GRADES.length - 1];

    return { total, grade: entry.grade };
}

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

/* ---------- Reliability ---------- */

function buildReliabilitySection(item) {
    const level = Number.isInteger(item.reliability) && item.reliability >= 0 && item.reliability <= 4
        ? item.reliability
        : null;
    const note = typeof item.reliable === 'string' && item.reliable.trim() !== '' && item.reliable.trim() !== '-'
        ? item.reliable
        : '';

    if (level === null && !note) return '';

    const indicator = level === null ? '' : `
                <p class="reliability-indicator">
                    <span class="reliability-dot" data-level="${level}" aria-hidden="true"></span>
                    <span class="reliability-text">${level}/4 confidence</span>
                </p>`;

    return `
            <section class="preview-reliable">
                <h3 class="preview-label">Placement reliability</h3>${indicator}
                ${note ? `<p>${escapeHTML(note)}</p>` : ''}
            </section>`;
}

/* ---------- List ---------- */

function renderList(data, container, filter, query = '') {
    container.innerHTML = '';
    let rankCounter = 1;
    let shown = 0;
    const needle = normalizeText(query);

    data.forEach(item => {
        const isUnranked = UNRANKED_STATUSES.includes(item.promoted);
        let rankDisplay = "—";
        let rankLabel = "Unranked";
        if (!isUnranked) {
            rankDisplay = `#${rankCounter}`;
            rankLabel = `Rank ${rankCounter}`;
            rankCounter++;
        }

        const marker = STATUS_MARKERS[item.promoted];
        if (marker) {
            rankDisplay = isUnranked ? marker.symbol : rankDisplay + marker.symbol;
            rankLabel += `, ${marker.label}`;
        }

        if (filter !== 'All' && item.promoted !== filter) {
            return;
        }
        if (needle && !normalizeText(item.name).includes(needle)) {
            return;
        }
        shown++;

        const li = document.createElement('li');
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'ranking-item';
        if (item === selectedItem) button.setAttribute('aria-current', 'true');

        button.innerHTML = `
            <span class="rank-badge" aria-hidden="true"${markerTitleAttr(item)}>${rankDisplay}</span>
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
        empty.textContent = 'No levels match your search.';
        container.appendChild(empty);
    }

    const status = document.getElementById('results-status');
    if (status) {
        const narrowed = needle || filter !== 'All';
        status.textContent = narrowed
            ? `Showing ${shown} of ${data.length} levels`
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
                    <span class="preview-rank" aria-hidden="true"${markerTitleAttr(item)}>${rankDisplay}</span>
                    <span class="sr-only">${rankLabel}:</span>${escapeHTML(item.name)}
                    <span class="preview-meta">${escapeHTML(item.creator)}</span>
                </h2>
                <p class="preview-meta">${escapeHTML(item.promoted)}</p>
            </header>
            ${buildCommentsSection(item)}
            ${buildVideoSection(item)}
            ${buildScoreSection(item)}
            <dl class="preview-stats">
                ${buildStats(item)}
            </dl>
            ${buildReliabilitySection(item)}
        </article>
    `;
}
