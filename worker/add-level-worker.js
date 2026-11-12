/**
 * Add Level worker for lxnarmoon-website (Cloudflare Workers, module syntax).
 *
 * The website is static, so it can't safely hold a GitHub token or check a login.
 * This worker does both: it checks a Google Authenticator code, then commits the new
 * level file and the updated index to GitHub in a single commit.
 *
 *   POST /login    { code }                   -> { token, expiresAt }
 *   POST /levels   { list, level, file? }     -> { ok, file, commit, url, discord, announcement? }   (Bearer token)
 *   POST /preview  { list, level, file? }     -> { ok, announcement, webhook }   (Bearer token; saves and posts nothing)
 *
 * After a level is added to the EDL list, the worker also posts a changelog message to Discord
 * (placements by difficulty, score and attempts). `discord` says what happened: 'sent',
 * 'skipped' (no webhook set up) or 'failed'. The level is saved either way; when the post
 * fails, `announcement` holds the message so it can be posted by hand.
 *
 * Setup steps are in worker/README.md. Nothing secret lives in this file.
 *
 * Settings (Cloudflare dashboard -> your Worker -> Settings):
 *   TOTP_SECRET          secret    base32 key shared with your Authenticator app
 *   GITHUB_TOKEN         secret    fine-grained token, this repo only, Contents: read and write
 *   ALLOWED_ORIGIN       variable  site origin(s), comma separated, e.g. https://you.github.io
 *   RATE_LIMIT           KV binding used for lockouts and one-time-use codes
 *   DISCORD_WEBHOOK_URL  secret    optional, the changelog channel's webhook address
 *   DISCORD_ROLE_ID      variable  optional, role pinged under each post (defaults to EDS Changelog)
 *   GITHUB_REPO          variable  optional, defaults to the repo below
 *   GITHUB_BRANCH        variable  optional, defaults to main
 */

const DEFAULT_REPO = 'lxnarmoon/lxnarmoon-website';
const DEFAULT_BRANCH = 'main';
const LISTS = ['edl', 'idl', 'hdl', 'mdl'];

const TOTP_STEP_MS = 30_000;
const SESSION_MS = 30 * 60_000;

// Lockouts. The code is only 6 digits, so guessing has to be slow:
// 5 misses lock one address for 15 minutes, 20 misses lock everyone for an hour.
const IP_FAIL_LIMIT = 5;
const IP_FAIL_WINDOW_S = 15 * 60;
const GLOBAL_FAIL_LIMIT = 20;
const GLOBAL_FAIL_WINDOW_S = 60 * 60;

const MAX_BODY_CHARS = 20_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

export default {
    async fetch(request, env) {
        try {
            return await handle(request, env);
        } catch (error) {
            if (error instanceof HttpError) {
                return json(error.status, { error: error.message, ...error.extra }, request, env);
            }
            console.error('Unexpected error', error);
            return json(500, { error: 'Something went wrong on the server.' }, request, env);
        }
    }
};

/* ---------- Routing, CORS, responses ---------- */

async function handle(request, env) {
    const origins = allowedOrigins(env);
    const origin = request.headers.get('Origin');

    // Browsers always send Origin on cross-site requests. A site that isn't listed gets nothing.
    // (This is a courtesy check; the authenticator code is what actually protects writes.)
    if (origin && !origins.includes(origin)) {
        throw new HttpError(403, 'This site is not allowed to use the Add Level service.');
    }

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== 'POST') {
        throw new HttpError(405, 'Use POST.');
    }

    requireConfig(env);

    const route = new URL(request.url).pathname.replace(/\/+$/, '');
    if (route === '/login') return json(200, await login(request, env), request, env);
    if (route === '/levels') return json(200, await addLevel(request, env), request, env);
    if (route === '/preview') return json(200, await previewAnnouncement(request, env), request, env);
    throw new HttpError(404, 'Not found.');
}

function allowedOrigins(env) {
    return String(env.ALLOWED_ORIGIN || '')
        .split(',')
        .map(value => value.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && allowedOrigins(env).includes(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '600',
            'Vary': 'Origin'
        };
    }
    return { 'Vary': 'Origin' };
}

function json(status, body, request, env) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...corsHeaders(request, env)
        }
    });
}

// Fail closed: if anything needed for security is missing, refuse instead of guessing.
function requireConfig(env) {
    const missing = ['TOTP_SECRET', 'GITHUB_TOKEN', 'RATE_LIMIT'].filter(key => !env[key]);
    if (missing.length) {
        console.error('Add Level worker is missing settings:', missing.join(', '));
        throw new HttpError(500, 'The Add Level service is not fully set up yet.');
    }
}

async function readJson(request) {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_CHARS) {
        throw new HttpError(413, 'That request is too large.');
    }
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) {
        throw new HttpError(413, 'That request is too large.');
    }
    try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
        // falls through to the error below
    }
    throw new HttpError(400, 'The request body must be a JSON object.');
}

/* ---------- Authenticator code (TOTP, RFC 6238) ---------- */

function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(input).toUpperCase().replace(/[\s=-]+/g, '');
    const bytes = [];
    let bits = 0;
    let value = 0;

    for (const char of clean) {
        const index = alphabet.indexOf(char);
        if (index === -1) throw new Error('TOTP_SECRET is not valid base32.');
        value = ((value << 5) | index) & 0xfff;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(bytes);
}

async function hotp(key, counter) {
    const message = new ArrayBuffer(8);
    new DataView(message).setBigUint64(0, BigInt(counter));
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    const offset = digest[19] & 0x0f;
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        (digest[offset + 1] << 16) |
        (digest[offset + 2] << 8) |
        digest[offset + 3];
    return String(binary % 1_000_000).padStart(6, '0');
}

function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}

// Accepts the code for the current 30 second step and one step either side (clock drift).
// Returns the matching step number, or null. All three are always compared.
async function findTotpStep(secret, code, nowMs) {
    const key = await crypto.subtle.importKey(
        'raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const current = Math.floor(nowMs / TOTP_STEP_MS);
    let match = null;
    for (const step of [current - 1, current, current + 1]) {
        if (safeEqual(await hotp(key, step), code)) match = step;
    }
    return match;
}

/* ---------- Lockouts ---------- */

async function readCounter(env, key, now) {
    const stored = await env.RATE_LIMIT.get(key, 'json');
    if (stored && Number.isFinite(stored.count) && stored.resetAt > now) return stored;
    return { count: 0, resetAt: 0 };
}

async function recordFailure(env, key, state, now, windowSeconds) {
    const resetAt = state.count > 0 ? state.resetAt : now + windowSeconds * 1000;
    const ttl = Math.max(60, Math.ceil((resetAt - now) / 1000));
    await env.RATE_LIMIT.put(key, JSON.stringify({ count: state.count + 1, resetAt }), { expirationTtl: ttl });
}

function lockedOut(resetAt, now) {
    const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return new HttpError(429, 'Too many wrong codes. Try again later.', { retryAfter: seconds });
}

/* ---------- Sessions ---------- */

function base64urlEncode(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

// The session key is derived from the authenticator secret, so there is no second secret to manage.
async function sessionKey(env) {
    const root = await crypto.subtle.importKey(
        'raw', encoder.encode(env.TOTP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const derived = await crypto.subtle.sign('HMAC', root, encoder.encode('add-level session key v1'));
    return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueSession(env, now) {
    const expiresAt = now + SESSION_MS;
    const payload = base64urlEncode(encoder.encode(JSON.stringify({ exp: expiresAt })));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await sessionKey(env), encoder.encode(payload)));
    return { token: `${payload}.${base64urlEncode(signature)}`, expiresAt };
}

async function requireSession(request, env) {
    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const [payload, signature] = token.split('.');
    const unlockAgain = new HttpError(401, 'Please unlock again with a new code.');
    if (!payload || !signature) throw unlockAgain;

    let valid = false;
    try {
        valid = await crypto.subtle.verify(
            'HMAC', await sessionKey(env), base64urlDecode(signature), encoder.encode(payload)
        );
    } catch {
        valid = false;
    }
    if (!valid) throw unlockAgain;

    let expiresAt;
    try {
        expiresAt = JSON.parse(decoder.decode(base64urlDecode(payload))).exp;
    } catch {
        throw unlockAgain;
    }
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        throw new HttpError(401, 'Your session ended. Unlock again with a new code.');
    }
}

/* ---------- POST /login ---------- */

async function login(request, env) {
    const body = await readJson(request);
    const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
    const now = Date.now();
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    const ipKey = `fail:ip:${ip}`;
    const globalKey = 'fail:global';
    const [ipState, globalState] = await Promise.all([
        readCounter(env, ipKey, now),
        readCounter(env, globalKey, now)
    ]);

    // Checked before the code is looked at, so a locked-out guesser never learns whether a guess was right.
    if (globalState.count >= GLOBAL_FAIL_LIMIT) throw lockedOut(globalState.resetAt, now);
    if (ipState.count >= IP_FAIL_LIMIT) throw lockedOut(ipState.resetAt, now);

    let step = null;
    if (/^\d{6}$/.test(code)) {
        try {
            step = await findTotpStep(env.TOTP_SECRET, code, now);
        } catch (error) {
            console.error('TOTP check failed', error.message);
            throw new HttpError(500, 'The Add Level service is not fully set up yet.');
        }
    }

    if (step === null) {
        await Promise.all([
            recordFailure(env, ipKey, ipState, now, IP_FAIL_WINDOW_S),
            recordFailure(env, globalKey, globalState, now, GLOBAL_FAIL_WINDOW_S)
        ]);
        throw new HttpError(401, 'That code is not valid.');
    }

    // Each code works once. Reusing one (or an older one) is refused.
    const lastStep = Number(await env.RATE_LIMIT.get('totp:last-step')) || 0;
    if (step <= lastStep) {
        throw new HttpError(401, 'That code was already used. Wait for the next one.');
    }
    await env.RATE_LIMIT.put('totp:last-step', String(step), { expirationTtl: 300 });
    await env.RATE_LIMIT.delete(ipKey);

    return issueSession(env, now);
}

/* ---------- Level validation ---------- */

function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
    return NaN;
}

function slugify(name, id) {
    const slug = String(name)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60)
        .replace(/_+$/g, '');
    return slug || `level_${id}`;
}

// Same rules as getYouTubeId in script/script.js.
function isYouTubeLink(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

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
    return Boolean(id) && /^[A-Za-z0-9_-]{11}$/.test(id);
}

// Builds a clean level object from untrusted input. Only known fields are copied, in the same
// order as data/cognition.json, so nothing extra can be written to the repository.
function validateLevel(input, requestedFile) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const errors = {};
    const level = {};

    const text = (key, { required = false, max }) => {
        const raw = source[key];
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
            if (required) errors[key] = 'Required.';
            return undefined;
        }
        if (typeof raw !== 'string') {
            errors[key] = 'Must be text.';
            return undefined;
        }
        const value = raw.replace(/\r\n?/g, '\n').trim();
        if (value.length > max) {
            errors[key] = `Keep this under ${max} characters.`;
            return undefined;
        }
        return value;
    };

    const whole = (key, { required = false, min, max }) => {
        const raw = source[key];
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
            if (required) errors[key] = 'Required.';
            return undefined;
        }
        const value = toNumber(raw);
        if (!Number.isInteger(value) || value < min || value > max) {
            errors[key] = `Use a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`;
            return undefined;
        }
        return value;
    };

    const name = text('name', { required: true, max: 100 });
    if (name !== undefined) level.name = name;

    const creator = text('creator', { required: true, max: 100 });
    if (creator !== undefined) level.creator = creator;

    const id = whole('id', { required: true, min: 1, max: 2_147_483_647 });
    if (id !== undefined) level.id = id;

    // Kept as text ("14.10") so trailing zeros survive, like the existing level files.
    const rawDifficulty = typeof source.diffRating === 'number' ? String(source.diffRating) : source.diffRating;
    const difficulty = typeof rawDifficulty === 'string' ? rawDifficulty.trim() : '';
    if (!difficulty) {
        errors.diffRating = 'Required.';
    } else if (!/^\d{1,3}(\.\d{1,4})?$/.test(difficulty) || Number(difficulty) <= 0 || Number(difficulty) > 100) {
        errors.diffRating = 'Use a number like 14.15.';
    } else {
        level.diffRating = difficulty;
    }

    const video = text('video', { max: 200 });
    if (video !== undefined) {
        if (isYouTubeLink(video)) level.video = video;
        else errors.video = 'Use a YouTube link (youtu.be, youtube.com/watch, /shorts, /embed or /live).';
    }

    const comments = text('comments', { max: 2000 });
    if (comments !== undefined) level.comments = comments;

    for (const key of ['gameplay', 'deco', 'song']) {
        const score = whole(key, { required: true, min: 0, max: 100 });
        if (score !== undefined) level[key] = score;
    }

    const attempts = whole('attempts', { min: 0, max: 1_000_000_000 });
    if (attempts !== undefined) level.attempts = attempts;

    const rawFail = source.worstFail;
    if (rawFail !== undefined && rawFail !== null && !(typeof rawFail === 'string' && rawFail.trim() === '')) {
        const worstFail = toNumber(rawFail);
        if (!Number.isFinite(worstFail) || worstFail < 0 || worstFail > 100) {
            errors.worstFail = 'Use a percentage from 0 to 100.';
        } else {
            level.worstFail = worstFail;
        }
    }

    let file = requestedFile;
    if (file === undefined || file === null || file === '') {
        file = slugify(level.name ?? '', level.id);
    }
    if (typeof file !== 'string' || file.length > 60 || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(file)) {
        errors.file = 'Use lowercase letters, numbers and single underscores, like my_level.';
    }

    return { level, file, errors: Object.keys(errors).length ? errors : null };
}

/* ---------- POST /levels ---------- */

async function addLevel(request, env) {
    await requireSession(request, env);
    const body = await readJson(request);

    if (!LISTS.includes(body.list)) {
        throw new HttpError(400, 'Unknown list.');
    }

    const { level, file, errors } = validateLevel(body.level, body.file);
    if (errors) {
        throw new HttpError(400, 'Some fields need fixing.', { fields: errors });
    }

    const saved = await commitLevel(env, { list: body.list, file, level });

    // The level is already committed, so nothing below may undo it or throw.
    if (body.list === 'edl') {
        Object.assign(saved.result, await announceLevel(env, { ...saved, level }));
    }
    return saved.result;
}

/* ---------- GitHub ---------- */

async function github(env, path, { method = 'GET', body, okStatuses = [] } = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'lxnarmoon-add-level',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (response.ok || okStatuses.includes(response.status)) return response;

    console.error('GitHub error', method, path, response.status, (await response.text()).slice(0, 300));
    if (response.status === 401 || response.status === 403) {
        throw new HttpError(502, 'GitHub refused the request. Check the token and its permissions.');
    }
    throw new HttpError(502, `GitHub returned an error (${response.status}).`);
}

function decodeBase64Utf8(value) {
    const binary = atob(String(value).replace(/\s/g, ''));
    return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

async function commitLevel(env, { list, file, level }) {
    const repo = env.GITHUB_REPO || DEFAULT_REPO;
    const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
    const base = `/repos/${repo}`;
    const levelPath = `data/${file}.json`;
    const indexPath = `data/_${list}.json`;

    const ref = await (await github(env, `${base}/git/ref/heads/${branch}`)).json();
    const headSha = ref.object.sha;
    const head = await (await github(env, `${base}/git/commits/${headSha}`)).json();

    // Never overwrite an existing level.
    const existing = await github(env, `${base}/contents/${levelPath}?ref=${headSha}`, { okStatuses: [404] });
    if (existing.status !== 404) {
        throw new HttpError(409, `${levelPath} already exists. Choose a different file name.`, {
            fields: { file: 'That file name is already taken.' }
        });
    }

    const indexResponse = await github(env, `${base}/contents/${indexPath}?ref=${headSha}`, { okStatuses: [404] });
    if (indexResponse.status === 404) {
        throw new HttpError(500, `${indexPath} was not found in the repository.`);
    }
    let index = null;
    try {
        index = JSON.parse(decodeBase64Utf8((await indexResponse.json()).content));
    } catch {
        index = null;
    }
    if (!Array.isArray(index) || !index.every(entry => typeof entry === 'string')) {
        throw new HttpError(500, `${indexPath} is not a plain list of file names, so it was left alone.`);
    }

    // The list as it was before this level, used afterwards to work out where the level placed.
    const entries = [...index];

    const files = [{ path: levelPath, content: JSON.stringify(level, null, 4) + '\n' }];
    // An entry may already exist without a file (a placeholder). Then only the file is added.
    if (!index.some(entry => entry.replace(/\.json$/, '') === file)) {
        index.push(file);
        files.push({ path: indexPath, content: JSON.stringify(index, null, 4) + '\n' });
    }

    const tree = await (await github(env, `${base}/git/trees`, {
        method: 'POST',
        body: {
            base_tree: head.tree.sha,
            tree: files.map(({ path, content }) => ({ path, mode: '100644', type: 'blob', content }))
        }
    })).json();

    const title = `Add level: ${level.name}`.replace(/[\r\n]+/g, ' ').slice(0, 100);
    const commit = await (await github(env, `${base}/git/commits`, {
        method: 'POST',
        body: {
            message: `${title}\n\nAdded to the ${list.toUpperCase()} list from the Add Level page.`,
            tree: tree.sha,
            parents: [headSha]
        }
    })).json();

    const update = await github(env, `${base}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
        okStatuses: [422]
    });
    if (update.status === 422) {
        throw new HttpError(409, 'The repository changed while saving. Nothing was added; please try again.');
    }

    return {
        result: { ok: true, file: levelPath, list, commit: commit.sha, url: commit.html_url },
        repo,
        headSha,
        entries
    };
}

/* ---------- Discord announcement (EDL list only) ---------- */

// Role pinged under every post. Change it with the DISCORD_ROLE_ID variable instead of editing this.
const DEFAULT_PING_ROLE_ID = '1439890188078944356';
const DISCORD_MAX_CHARS = 2000;
const TOP_TEN = 10;

// Levels are read from GitHub in a single query per batch, because a worker may only make a
// limited number of outside requests and a list can hold hundreds of levels.
const GRAPHQL_BATCH = 150;
const GRAPHQL_MAX_BATCHES = 10;

// Same weights as the website: gameplay 70%, deco 20%, song 10%.
const SCORE_PARTS = [['gameplay', 7], ['deco', 2], ['song', 1]];

// In the order they appear in the message. Every board is sorted high to low.
const BOARDS = [
    { key: 'difficulty', by: 'difficulty', title: 'Top Ten By Difficulty' },
    { key: 'score', by: 'score', title: 'Top Ten By Score' },
    { key: 'attempts', by: 'attempts', title: 'Top Ten By Attempts' }
];

// The three numbers a level is ranked by. A missing value is null (the level is left off that board).
function levelMetrics(level) {
    const raw = level?.diffRating;
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    const difficulty = /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;

    // The weighted total times ten, so equal scores are exactly equal with no rounding drift.
    const score = SCORE_PARTS.every(([key]) => Number.isFinite(level?.[key]))
        ? SCORE_PARTS.reduce((sum, [key, weight]) => sum + level[key] * weight, 0)
        : null;

    const attempts = Number.isFinite(level?.attempts) ? level.attempts : null;
    return { difficulty, score, attempts };
}

// Equal values are ordered A-Z by name, ignoring capitals. The website's sorting uses the same rule
// (NAME_COLLATOR in script/script.js), so a placement here is the place the site shows.
const NAME_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' });

// Where the new level lands on each board, and who it pushes out of a top ten.
function computePlacements(existing, level) {
    const mine = levelMetrics(level);
    const myName = typeof level?.name === 'string' ? level.name : '';
    const others = existing.map(({ file, level: other }) => ({
        file,
        name: typeof other?.name === 'string' && other.name.trim() ? other.name.trim() : file,
        metrics: levelMetrics(other)
    }));

    return BOARDS.flatMap(board => {
        const value = mine[board.key];
        if (value === null) return [];

        const ranked = others
            .filter(other => other.metrics[board.key] !== null)
            .sort((a, b) => b.metrics[board.key] - a.metrics[board.key]
                || NAME_COLLATOR.compare(a.name, b.name)
                || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
        // Everything that beats the new level: a higher value, or the same value and a name that sorts first.
        const rank = 1 + ranked.filter(other => other.metrics[board.key] > value
            || (other.metrics[board.key] === value && NAME_COLLATOR.compare(other.name, myName) <= 0)).length;

        // The level sitting at #10 right now drops to #11. Nobody drops out of a list that
        // doesn't have ten ranked levels yet.
        const pushed = rank <= TOP_TEN ? ranked[TOP_TEN - 1] : undefined;
        return [{ board, rank, pushedOut: pushed ? { file: pushed.file, name: pushed.name } : null }];
    });
}

// Backslash-escapes the characters Discord would otherwise read as formatting, links, emoji or mentions.
function escapeInline(text) {
    return String(text).replace(/[\\*_~`|>#<@:[\]()-]/g, '\\$&');
}

function escapeName(name) {
    return escapeInline(String(name).replace(/\s+/g, ' ').trim());
}

// "a", "a and b", "a, b, and c".
function joinList(items) {
    if (items.length <= 2) {
        // two items that already contain "and" read better with a comma
        return items.join(items.some(item => item.includes(' and ')) ? ', and ' : ' and ');
    }
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// The italic, quoted comment. Each line is italicised on its own so line breaks can't break it.
function commentBlock(comment) {
    const lines = String(comment).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(escapeInline);
    if (!lines.length) return '';
    lines[0] = `"${lines[0]}`;
    lines[lines.length - 1] += '"';
    return lines.map(line => `*${line}*`).join('\n');
}

// "This pushes X out of my Top Ten By Difficulty, and Y out of my Top Ten By Score."
// One entry per level that was pushed out; a level pushed out of two lists is named once.
function pushLine(placements) {
    const groups = new Map();
    for (const { board, rank, pushedOut } of placements) {
        if (rank > TOP_TEN || !pushedOut) continue;
        const group = groups.get(pushedOut.file) ?? { name: pushedOut.name, titles: [] };
        group.titles.push(board.title);
        groups.set(pushedOut.file, group);
    }
    if (!groups.size) return null;

    const parts = [...groups.values()].map(({ name, titles }) => `${escapeName(name)} out of my ${titles.length === 2 ? titles.join(' and ') : joinList(titles)}`);
    const text = parts.length === 2 ? parts.join(', and ') : joinList(parts);
    return `*This pushes ${text}.*`;
}

// The whole message:
//   **Level** has been placed, placing at **#1** by difficulty, **#2** by score, and **#3** by attempts.
//   *This pushes Other out of my Top Ten By Difficulty, and Another out of my Top Ten By Score.*
//                                                    <- or, when nothing is pushed out, the comment
//
//   <@&role>
function buildAnnouncement(level, placements, roleId) {
    const spots = placements.map(({ board, rank }) => `**#${rank}** by ${board.by}`);
    const opening = `**${escapeName(level.name)}** has been placed, placing at ${joinList(spots)}.`;
    const pushes = pushLine(placements);
    const ping = `<@&${roleId}>`;

    const assemble = comment => [opening, pushes ?? commentBlock(comment)].filter(Boolean).join('\n') + `\n\n${ping}`;

    // Discord rejects messages over 2000 characters, so a very long comment is shortened.
    let comment = typeof level.comments === 'string' ? level.comments.trim() : '';
    let content = assemble(comment);
    while (content.length > DISCORD_MAX_CHARS && comment.length > 0) {
        comment = comment.slice(0, Math.max(0, Math.floor(comment.length * 0.9) - 1)).trimEnd();
        content = assemble(comment ? `${comment}…` : '');
    }
    return content;
}

function isDiscordWebhook(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname)
            && /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname);
    } catch {
        return false;
    }
}

function redact(text, secrets) {
    let out = String(text ?? '');
    for (const secret of secrets) {
        if (secret) out = out.split(String(secret)).join('[hidden]');
    }
    return out;
}

// Reads every existing level file as of one commit, a batch of files per request.
async function fetchExistingLevels(env, repo, sha, entries) {
    const [owner, name] = repo.split('/');
    const files = [...new Set(entries.map(entry => entry.replace(/\.json$/, '')))]
        .filter(file => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file));

    const batches = [];
    for (let i = 0; i < files.length; i += GRAPHQL_BATCH) batches.push(files.slice(i, i + GRAPHQL_BATCH));
    if (batches.length > GRAPHQL_MAX_BATCHES) throw new Error('There are too many levels to read at once.');

    const results = await Promise.all(batches.map(async batch => {
        const fields = batch
            .map((file, i) => `l${i}: object(expression: ${JSON.stringify(`${sha}:data/${file}.json`)}) { ... on Blob { text } }`)
            .join('\n');
        const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'lxnarmoon-add-level'
            },
            body: JSON.stringify({
                query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`,
                variables: { owner, name }
            })
        });
        if (!response.ok) throw new Error(`GitHub returned ${response.status} while reading the levels.`);

        const payload = await response.json();
        const repository = payload?.data?.repository;
        if (!repository) throw new Error(`GitHub sent no level data. ${payload?.errors?.[0]?.message ?? ''}`.trim());

        return batch.flatMap((file, i) => {
            // An index entry with no file yet (a placeholder) comes back empty and is skipped.
            const text = repository[`l${i}`]?.text;
            if (typeof text !== 'string') return [];
            try {
                const level = JSON.parse(text);
                return level && typeof level === 'object' && !Array.isArray(level) ? [{ file, level }] : [];
            } catch {
                return [];
            }
        });
    }));

    return results.flat();
}

function pingRoleId(env) {
    return /^\d{15,25}$/.test(String(env.DISCORD_ROLE_ID || '').trim())
        ? String(env.DISCORD_ROLE_ID).trim()
        : DEFAULT_PING_ROLE_ID;
}

async function composeAnnouncement(env, { repo, headSha, entries, level }) {
    const existing = await fetchExistingLevels(env, repo, headSha, entries);
    return buildAnnouncement(level, computePlacements(existing, level), pingRoleId(env));
}

// Never throws: the level is already saved, so a Discord problem only changes the `discord` status.
async function announceLevel(env, state) {
    const webhook = String(env.DISCORD_WEBHOOK_URL || '').trim();
    if (!webhook) return { discord: 'skipped' };

    let content = null;
    try {
        content = await composeAnnouncement(env, state);

        if (!isDiscordWebhook(webhook)) throw new Error('DISCORD_WEBHOOK_URL is not a Discord webhook address.');
        const response = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Only the one role may be pinged, so nothing in a level name or comment can ping anyone else.
            body: JSON.stringify({ content, allowed_mentions: { parse: [], roles: [pingRoleId(env)] } })
        });
        if (!response.ok) throw new Error(`Discord returned ${response.status}.`);
        return { discord: 'sent' };
    } catch (error) {
        console.error('Discord post failed:', redact(error?.message, [webhook, env.GITHUB_TOKEN]));
        return content ? { discord: 'failed', announcement: content } : { discord: 'failed' };
    }
}

/* ---------- POST /preview ---------- */

// Shows the message that adding this level would post, without saving or posting anything.
async function previewAnnouncement(request, env) {
    await requireSession(request, env);
    const body = await readJson(request);

    if (body.list !== 'edl') throw new HttpError(400, 'Announcements are only posted for the EDL list.');
    const { level, errors } = validateLevel(body.level, body.file);
    if (errors) throw new HttpError(400, 'Some fields need fixing.', { fields: errors });

    const repo = env.GITHUB_REPO || DEFAULT_REPO;
    const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
    const base = `/repos/${repo}`;
    const ref = await (await github(env, `${base}/git/ref/heads/${branch}`)).json();
    const headSha = ref.object.sha;
    const indexResponse = await github(env, `${base}/contents/data/_edl.json?ref=${headSha}`);

    let entries = null;
    try {
        entries = JSON.parse(decodeBase64Utf8((await indexResponse.json()).content));
    } catch {
        entries = null;
    }
    if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) {
        throw new HttpError(500, 'data/_edl.json is not a plain list of file names.');
    }

    let announcement;
    try {
        announcement = await composeAnnouncement(env, { repo, headSha, entries, level });
    } catch (error) {
        console.error('Preview failed:', redact(error?.message, [env.GITHUB_TOKEN]));
        throw new HttpError(502, 'Could not read the existing levels to work out the placements.');
    }
    return { ok: true, announcement, webhook: Boolean(String(env.DISCORD_WEBHOOK_URL || '').trim()) };
}
