// public/auth.js
// Small client-side auth helper for LearningHub.
// Include in pages: <script src="/auth.js"></script>
// Configure API_BASE if your backend runs on another origin: Auth.config({ apiBase: 'http://localhost:4000' });

(function (global) {
  const storageTokenKey = 'lh_token';
  const storageUserKey = 'lh_user';
  let API_BASE = '';

  // default: same origin
  function config(opts = {}) {
    if (opts.apiBase) API_BASE = opts.apiBase.replace(/\/$/, '');
  }

  function apiUrl(path) {
    if (!path) return API_BASE || '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return (API_BASE || '') + path;
  }

  async function fetchJson(path, opts = {}) {
    try {
      const res = await fetch(apiUrl(path), opts);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!res.ok) {
        const err = (data && (data.error || data.message)) ? (data.error || data.message) : res.statusText;
        return { ok: false, status: res.status, error: err, data };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, error: err.message || 'Network error' };
    }
  }

  /* Auth storage helpers */
  function saveAuth(token, user) {
    if (token) localStorage.setItem(storageTokenKey, token);
    if (user) localStorage.setItem(storageUserKey, JSON.stringify(user));
  }
  function clearAuth() {
    localStorage.removeItem(storageTokenKey);
    localStorage.removeItem(storageUserKey);
  }
  function getToken() {
    return localStorage.getItem(storageTokenKey);
  }
  function getUser() {
    const s = localStorage.getItem(storageUserKey);
    return s ? JSON.parse(s) : null;
  }
  function getAuthHeaders() {
    const t = getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }
  function isAdmin() {
    const u = getUser();
    return u && u.role === 'admin';
  }

  /* UI helpers: toggles visibility of elements with ids:
     #btn-login, #btn-register, #btn-logout and elements with class .admin-link
     If elements not present they are simply skipped.
  */
  function applyNavUI() {
    const token = getToken();
    const btnLogin = document.getElementById('btn-login');
    const btnRegister = document.getElementById('btn-register');
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogin) btnLogin.style.display = token ? 'none' : '';
    if (btnRegister) btnRegister.style.display = token ? 'none' : '';
    if (btnLogout) btnLogout.style.display = token ? '' : 'none';
    document.querySelectorAll('.admin-link').forEach(a => a.style.display = (token && isAdmin()) ? '' : 'none');
  }

  /* high-level actions */
  async function login(username, password) {
    if (!username || !password) return { ok: false, error: 'Missing username/password' };
    const r = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!r.ok) return r;
    saveAuth(r.data.token, r.data.user);
    applyNavUI();
    return r;
  }

  async function register(username, fullName, password) {
    if (!username || !fullName || !password) return { ok: false, error: 'Missing fields' };
    const r = await fetchJson('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, fullName, password })
    });
    if (!r.ok) return r;
    saveAuth(r.data.token, r.data.user);
    applyNavUI();
    return r;
  }

  function logout() {
    clearAuth();
    applyNavUI();
  }

  /* convenience: attach handlers if those buttons exists */
  function attachDefaultButtons() {
    const btnLogin = document.getElementById('btn-login');
    const btnRegister = document.getElementById('btn-register');
    const btnLogout = document.getElementById('btn-logout');

    if (btnLogin) btnLogin.addEventListener('click', async () => {
      const username = prompt('Username:');
      const password = prompt('Password:');
      if (!username || !password) return;
      const res = await login(username, password);
      if (!res.ok) return alert('Login failed: ' + (res.error || 'Unknown'));
      alert('Logged in');
    });

    if (btnRegister) btnRegister.addEventListener('click', async () => {
      const username = prompt('Username:');
      const fullName = prompt('Full name:');
      const password = prompt('Password:');
      if (!username || !fullName || !password) return;
      const res = await register(username, fullName, password);
      if (!res.ok) return alert('Register failed: ' + (res.error || 'Unknown'));
      alert('Registered & logged in');
    });

    if (btnLogout) btnLogout.addEventListener('click', () => {
      logout();
      alert('Logged out');
    });
  }

  /* init: auto-apply UI and attach handlers on DOMContentLoaded */
  function init(opts = {}) {
    if (opts.apiBase) config(opts);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        applyNavUI();
        attachDefaultButtons();
      });
    } else {
      applyNavUI();
      attachDefaultButtons();
    }
  }

  // Expose API
  const Auth = {
    config,
    init,
    fetchJson,
    saveAuth,
    clearAuth,
    getToken,
    getUser,
    getAuthHeaders,
    isAdmin,
    applyNavUI,
    login,
    register,
    logout
  };

  global.Auth = Auth;
})(window);
