// Add Level page.
//
// Unlocks with a Google Authenticator code, then sends the new level to the Cloudflare
// Worker in /worker, which writes the level file and updates the list's index on GitHub.
// This script holds no secrets: the worker checks the code and keeps the GitHub token.
//
// Paste the address of your deployed worker here (steps are in worker/README.md).
// It is a public address, not a secret. Example: 'https://add-level.yourname.workers.dev'
const WORKER_URL = 'add-level.luna-kmoon2.workers.dev';

(() => {
    // Which list this page adds to. The worker also accepts 'idl', 'hdl' and 'mdl'.
    const TARGET_LIST = 'edl';
    const SESSION_KEY = 'addLevelSession';
    const KEYS = ['name', 'creator', 'id', 'diffRating', 'video', 'comments', 'gameplay', 'deco', 'song', 'attempts', 'worstFail'];
    const FILE_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;

    const $ = id => document.getElementById(id);
    const field = key => $(`f-${key}`);

    const setupCard = $('setup-card');
    const lockCard = $('lock-card');
    const addCard = $('add-card');
    const unlockForm = $('unlock-form');
    const authCode = $('auth-code');
    const unlockButton = $('unlock-button');
    const unlockStatus = $('unlock-status');
    const lockButton = $('lock-button');
    const levelForm = $('level-form');
    const submitButton = $('submit-button');
    const formStatus = $('form-status');
    const jsonPreview = $('json-preview');
    const scoreLive = $('score-live');
    const fileDetails = $('file-details');

    let session = null;
    let expiryTimer = null;
    let fileTouched = false;
    let busy = false;

    /* ---------- Small helpers ---------- */

    function setStatus(element, state, message) {
        element.dataset.state = state;
        element.textContent = message;
    }

    // Same rule as the worker, so the file name shown here is the one that gets saved.
    function slugify(name, id) {
        const slug = String(name)
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60)
            .replace(/_+$/g, '');
        return slug || (id ? `level_${id}` : '');
    }

    /* ---------- Session (kept for this tab only) ---------- */

    function loadSession() {
        try {
            const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY));
            if (stored && typeof stored.token === 'string' && stored.exp > Date.now() + 5000) return stored;
        } catch {
            // no usable session
        }
        return null;
    }

    function saveSession(value) {
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch { /* private mode */ }
    }

    function clearSession() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
    }

    function scheduleExpiry() {
        clearTimeout(expiryTimer);
        if (!session) return;
        const wait = Math.min(Math.max(session.exp - Date.now(), 0), 2_000_000_000);
        expiryTimer = setTimeout(() => {
            showLocked('error', 'Your session ended. Enter a new code to keep adding levels.');
        }, wait);
    }

    /* ---------- Lock / unlock ---------- */

    function showLocked(state = '', message = '') {
        session = null;
        clearTimeout(expiryTimer);
        clearSession();
        addCard.hidden = true;
        lockCard.hidden = false;
        setStatus(unlockStatus, state, message);
        authCode.value = '';
        authCode.focus();
    }

    function showUnlocked(newSession) {
        session = newSession;
        saveSession(session);
        lockCard.hidden = true;
        addCard.hidden = false;
        setStatus(unlockStatus, '', '');
        scheduleExpiry();
        refresh();
    }

    async function callWorker(path, body, token) {
        let response;
        try {
            response = await fetch(WORKER_URL.replace(/\/+$/, '') + path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                },
                body: JSON.stringify(body)
            });
        } catch {
            return { status: 0, data: {} };
        }
        let data = {};
        try { data = await response.json(); } catch { /* not JSON */ }
        return { status: response.status, data };
    }

    const UNREACHABLE = "Couldn't reach the Add Level service. Check your connection and the WORKER_URL setting.";

    async function handleUnlock(event) {
        event.preventDefault();
        if (busy) return;

        const code = authCode.value.replace(/\s+/g, '');
        if (!/^\d{6}$/.test(code)) {
            setStatus(unlockStatus, 'error', 'Enter the 6-digit code from your authenticator app.');
            return;
        }

        busy = true;
        unlockButton.disabled = true;
        setStatus(unlockStatus, 'info', 'Checking…');
        const { status, data } = await callWorker('/login', { code });
        busy = false;
        unlockButton.disabled = false;

        if (status === 200 && typeof data.token === 'string' && Number.isFinite(data.expiresAt)) {
            authCode.value = '';
            showUnlocked({ token: data.token, exp: data.expiresAt });
            field('name').focus();
        } else if (status === 429) {
            const minutes = Math.max(1, Math.ceil((Number(data.retryAfter) || 60) / 60));
            setStatus(unlockStatus, 'error', `Too many wrong codes. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        } else if (status === 0) {
            setStatus(unlockStatus, 'error', UNREACHABLE);
        } else {
            setStatus(unlockStatus, 'error', data.error || 'Something went wrong. Try again.');
            authCode.select();
        }
    }

    /* ---------- Reading and checking the form ---------- */

    // Mirrors the worker's rules so mistakes are caught before sending. The worker checks again.
    function readForm() {
        const errors = {};
        const level = {};

        const text = (key, required, max) => {
            const value = field(key).value.replace(/\r\n?/g, '\n').trim();
            if (!value) {
                if (required) errors[key] = 'Required.';
                return undefined;
            }
            if (value.length > max) {
                errors[key] = `Keep this under ${max} characters.`;
                return undefined;
            }
            return value;
        };

        const whole = (key, required, min, max) => {
            const value = field(key).value.trim();
            if (!value) {
                if (required) errors[key] = 'Required.';
                return undefined;
            }
            const number = /^\d+$/.test(value) ? Number(value) : NaN;
            if (!Number.isInteger(number) || number < min || number > max) {
                errors[key] = `Use a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`;
                return undefined;
            }
            return number;
        };

        const name = text('name', true, 100);
        if (name !== undefined) level.name = name;

        const creator = text('creator', true, 100);
        if (creator !== undefined) level.creator = creator;

        const id = whole('id', true, 1, 2_147_483_647);
        if (id !== undefined) level.id = id;

        // Kept as text so "14.10" stays "14.10", like the existing level files.
        const difficulty = field('diffRating').value.trim();
        if (!difficulty) {
            errors.diffRating = 'Required.';
        } else if (!/^\d{1,3}(\.\d{1,4})?$/.test(difficulty) || Number(difficulty) <= 0 || Number(difficulty) > 100) {
            errors.diffRating = 'Use a number like 14.15.';
        } else {
            level.diffRating = difficulty;
        }

        const video = text('video', false, 200);
        if (video !== undefined) {
            if (getYouTubeId(video)) level.video = video;
            else errors.video = 'Use a YouTube link (youtu.be, youtube.com/watch, /shorts, /embed or /live).';
        }

        const comments = text('comments', false, 2000);
        if (comments !== undefined) level.comments = comments;

        for (const key of ['gameplay', 'deco', 'song']) {
            const score = whole(key, true, 0, 100);
            if (score !== undefined) level[key] = score;
        }

        const attempts = whole('attempts', false, 0, 1_000_000_000);
        if (attempts !== undefined) level.attempts = attempts;

        const fail = field('worstFail').value.trim();
        if (fail) {
            const worstFail = /^\d+(\.\d+)?$/.test(fail) ? Number(fail) : NaN;
            if (!Number.isFinite(worstFail) || worstFail > 100) errors.worstFail = 'Use a percentage from 0 to 100.';
            else level.worstFail = worstFail;
        }

        const file = field('file').value.trim();
        if (file && (file.length > 60 || !FILE_PATTERN.test(file))) {
            errors.file = 'Use lowercase letters, numbers and single underscores, like my_level.';
        }

        return { level, file, errors };
    }

    function showFieldErrors(errors) {
        [...KEYS, 'file'].forEach(key => {
            const message = errors[key];
            const message_el = $(`e-${key}`);
            if (message) {
                message_el.textContent = message;
                message_el.hidden = false;
                field(key).setAttribute('aria-invalid', 'true');
            } else {
                message_el.textContent = '';
                message_el.hidden = true;
                field(key).removeAttribute('aria-invalid');
            }
        });
        if (errors.file) fileDetails.open = true;
    }

    function focusFirstInvalid(errors) {
        const first = [...KEYS, 'file'].find(key => errors[key]);
        if (first) field(first).focus();
    }

    // Keeps the file name, the JSON preview and the overall score in step with the form.
    function refresh() {
        if (!fileTouched) {
            const name = field('name').value.trim();
            field('file').value = name ? slugify(name, field('id').value.trim()) : '';
        }

        const { level } = readForm();
        jsonPreview.textContent = Object.keys(level).length
            ? JSON.stringify(level, null, 4)
            : 'Fill in the form to see the JSON.';

        const score = calculateScore(level);
        scoreLive.textContent = score
            ? `Overall score: ${score.total}/100 (${score.grade})`
            : 'Overall score: enter all three scores.';
    }

    /* ---------- Saving ---------- */

    function showSuccess(level, result) {
        formStatus.dataset.state = 'success';
        formStatus.textContent = `Added “${level.name}” as ${result.file}. It shows up once the site rebuilds from GitHub. `;
        if (typeof result.url === 'string' && /^https:\/\/github\.com\//.test(result.url)) {
            const link = document.createElement('a');
            link.href = result.url;
            link.textContent = 'View the commit';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            formStatus.append(link);
        }
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (busy || !session) return;

        const { level, file, errors } = readForm();
        showFieldErrors(errors);
        if (Object.keys(errors).length) {
            setStatus(formStatus, 'error', 'Some fields need fixing.');
            focusFirstInvalid(errors);
            return;
        }

        busy = true;
        submitButton.disabled = true;
        setStatus(formStatus, 'info', 'Saving to GitHub…');
        const body = { list: TARGET_LIST, level };
        if (file) body.file = file;
        const { status, data } = await callWorker('/levels', body, session.token);
        busy = false;
        submitButton.disabled = false;

        if (status === 200 && data.ok) {
            const added = { ...level };
            levelForm.reset();
            fileTouched = false;
            showFieldErrors({});
            refresh();
            showSuccess(added, data);
            field('name').focus();
        } else if (status === 401) {
            showLocked('error', data.error || 'Your session ended. Enter a new code to continue. Your form is kept.');
        } else if ((status === 400 || status === 409) && data.fields) {
            showFieldErrors(data.fields);
            setStatus(formStatus, 'error', data.error || 'Some fields need fixing.');
            focusFirstInvalid(data.fields);
        } else if (status === 0) {
            setStatus(formStatus, 'error', UNREACHABLE);
        } else {
            setStatus(formStatus, 'error', data.error || 'Something went wrong. Nothing was added.');
        }
    }

    /* ---------- Start up ---------- */

    function init() {
        if (!/^https?:\/\//.test(WORKER_URL)) {
            lockCard.hidden = true;
            setupCard.hidden = false;
            return;
        }

        $('score-hint').textContent = 'Overall = ' + Object.keys(SCORE_WEIGHTS)
            .map(key => `${SCORE_LABELS[key]} ${SCORE_WEIGHTS[key] * 10}%`)
            .join(' + ');

        unlockForm.addEventListener('submit', handleUnlock);
        levelForm.addEventListener('submit', handleSubmit);
        lockButton.addEventListener('click', () => showLocked('info', 'Locked. Enter a new code to unlock again.'));

        levelForm.addEventListener('input', event => {
            const key = event.target.id.replace(/^f-/, '');
            if (key === 'file') fileTouched = event.target.value.trim() !== '';
            const message = $(`e-${key}`);
            if (message && !message.hidden) {
                message.hidden = true;
                message.textContent = '';
                event.target.removeAttribute('aria-invalid');
            }
            refresh();
        });

        // Timers can pause while a tab is hidden, so check the clock when it comes back.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && session && Date.now() >= session.exp) {
                showLocked('error', 'Your session ended. Enter a new code to keep adding levels.');
            }
        });

        const existing = loadSession();
        if (existing) showUnlocked(existing);
        else refresh();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
