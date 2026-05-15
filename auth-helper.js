/**
 * auth-helper.js
 * Gestion centralisée de l'authentification et des redirections
 */

function getDashboardByRole(role) {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'administrator' || normalized === 'admin') return 'admin_dashboard.html';
  if (normalized === 'agent') return 'agent_dashboard.html';
  return 'user_dashboard.html';
}

// ✅ Vérifier si l'utilisateur est connecté
async function checkAuth() {
  try {
    const response = await fetch('/api/auth-status');
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Erreur vérification auth:', error);
    return { loggedIn: false };
  }
}

// ✅ Rediriger vers login avec destination
function redirectToLogin(destination) {
  sessionStorage.setItem('redirectAfterLogin', destination || window.location.pathname);
  window.location.href = 'login.html';
}

// ✅ Rediriger vers signup avec destination
function redirectToSignup(destination) {
  sessionStorage.setItem('redirectAfterSignup', destination || window.location.pathname);
  window.location.href = 'inscription.html';
}

// ✅ Gérer la redirection après authentification
function handlePostAuthRedirect() {
  const loginRedirect = sessionStorage.getItem('redirectAfterLogin');
  const signupRedirect = sessionStorage.getItem('redirectAfterSignup');

  if (loginRedirect) {
    sessionStorage.removeItem('redirectAfterLogin');
    window.location.href = loginRedirect;
    return;
  }

  if (signupRedirect) {
    sessionStorage.removeItem('redirectAfterSignup');
    window.location.href = signupRedirect;
    return;
  }

  checkAuth().then((authStatus) => {
    if (authStatus?.loggedIn) {
      window.location.href = getDashboardByRole(authStatus?.user?.role);
    } else {
      window.location.href = 'user_dashboard.html';
    }
  }).catch(() => {
    window.location.href = 'user_dashboard.html';
  });
}

// ✅ Requérir l'authentification pour une page
async function requireAuth() {
  const authStatus = await checkAuth();
  if (!authStatus.loggedIn) {
    redirectToLogin();
  }
  return authStatus;
}

// ✅ Logout
async function logout() {
  try {
    sessionStorage.clear();
    localStorage.removeItem('authToken');

    const response = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'include'
    });

    const data = await response.json();

    if (data.success || response.ok) {
      window.location.href = 'index.html';
    }
  } catch (error) {
    console.error('Erreur logout:', error);
    window.location.href = 'index.html';
  }
}

// ✅ Direct logout via GET
function logoutNow() {
  window.location.href = '/api/logout';
}

// ✅ Mettre à jour le navbar basé sur l'auth status
async function updateNavbarAuth() {
  const authStatus = await checkAuth();

  // Find the nav element — handles .nav, .top-nav, and div.nav variants
  const navEl = document.querySelector('nav.nav, nav.top-nav, div.nav');
  if (!navEl) return;

  // Remove every static hardcoded auth button (the duplicate source)
  navEl.querySelectorAll('.nav-btn').forEach(el => el.remove());

  // Don't add auth buttons on login/inscription pages — user is already there
  const page = window.location.pathname.split('/').pop() || 'index.html';
  if (page === 'login.html' || page === 'inscription.html') {
    // Auto-redirect from login if already authenticated
    if (page === 'login.html' && authStatus.loggedIn) {
      const redirect = sessionStorage.getItem('redirectAfterLogin') || getDashboardByRole(authStatus?.user?.role);
      sessionStorage.removeItem('redirectAfterLogin');
      setTimeout(() => { window.location.href = redirect; }, 300);
    }
    return;
  }

  // Find or create the right-side auth container
  let authContainer = navEl.querySelector('#nav-auth');
  if (!authContainer) {
    authContainer = document.createElement('div');
    authContainer.id = 'nav-auth';
    navEl.appendChild(authContainer);
  }

  // Clear previous auth elements
  authContainer.innerHTML = '';

  if (authStatus.loggedIn) {
    const user = authStatus.user || {};
    const userName = typeof user.name === 'string'
      ? user.name
      : (user.name?.first_name
        ? `${user.name.first_name} ${user.name.last_name || ''}`.trim()
        : (user.email || 'Utilisateur'));

    const isAdmin = String(user.role || '').toLowerCase() === 'administrator' ||
                    String(user.role || '').toLowerCase() === 'admin';

    // Username chip
    const userChip = document.createElement('span');
    userChip.className = 'nav-auth-user';
    userChip.textContent = `👤 ${userName}`;
    authContainer.appendChild(userChip);

    // Dashboard / Admin button
    const dashBtn = document.createElement('a');
    dashBtn.href = getDashboardByRole(user.role);
    dashBtn.className = 'nav-auth-btn nav-auth-btn--dashboard';
    dashBtn.textContent = isAdmin ? '⚙️ Admin' : '📊 Tableau de bord';
    authContainer.appendChild(dashBtn);

    // Logout button
    const logoutBtn = document.createElement('a');
    logoutBtn.href = '#';
    logoutBtn.className = 'nav-auth-btn nav-auth-btn--logout';
    logoutBtn.textContent = '🚪 Déconnexion';
    logoutBtn.addEventListener('click', (e) => { e.preventDefault(); logout(); });
    authContainer.appendChild(logoutBtn);

  } else {
    // Login button
    const loginBtn = document.createElement('a');
    loginBtn.href = 'login.html';
    loginBtn.className = 'nav-auth-btn nav-auth-btn--login';
    loginBtn.textContent = '🔑 Connexion';
    authContainer.appendChild(loginBtn);

    // Signup button
    const signupBtn = document.createElement('a');
    signupBtn.href = 'inscription.html';
    signupBtn.className = 'nav-auth-btn nav-auth-btn--signup';
    signupBtn.textContent = '📝 Inscription';
    authContainer.appendChild(signupBtn);
  }
}

// ✅ Ajouter les protections sur les boutons d'action
function addAuthProtection() {
  const publishBtn = document.querySelector('[data-action="publish-property"]');
  if (publishBtn) {
    publishBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const authStatus = await checkAuth();
      if (!authStatus.loggedIn) {
        redirectToLogin('owner_add_property.html');
      } else {
        window.location.href = 'owner_add_property.html';
      }
    });
  }

  const visitBtns = document.querySelectorAll('[data-action="visit-property"]');
  visitBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const authStatus = await checkAuth();
      if (!authStatus.loggedIn) {
        const propertyId = btn.getAttribute('data-property-id');
        redirectToLogin(`detail.html?id=${propertyId}&action=visit`);
      } else {
        const propertyId = btn.getAttribute('data-property-id');
        window.location.href = `detail.html?id=${propertyId}&action=visit`;
      }
    });
  });
}

// ✅ Initialiser à la charge du document
document.addEventListener('DOMContentLoaded', () => {
  updateNavbarAuth();
  addAuthProtection();
});
