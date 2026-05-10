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
  // Sauvegarder la destination souhaitée
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
  // Vérifier si on a une destination stockée
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

  // Par défaut, rediriger vers le tableau de bord selon le rôle
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
    // Clear session on frontend
    sessionStorage.clear();
    localStorage.removeItem('authToken');
    
    // Call logout endpoint - both POST and GET work
    const response = await fetch('/api/logout', { 
      method: 'POST',
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (data.success || response.ok) {
      console.log('✅ Déconnexion réussie');
      window.location.href = 'index.html';
    }
  } catch (error) {
    console.error('Erreur logout:', error);
    // Force redirect even if logout fails
    window.location.href = 'index.html';
  }
}

// ✅ Direct logout via GET (simple redirect)
function logoutNow() {
  window.location.href = '/api/logout';
}

// ✅ Mettre à jour le navbar basé sur l'auth status
async function updateNavbarAuth() {
  const authStatus = await checkAuth();
  
  // Chercher les éléments du navbar
  const navLinks = document.querySelector('.nav-links');
  const navUnified = document.querySelector('.nav-unified .nr');
  
  // Fonction pour ajouter les éléments au navbar
  const addAuthElements = (container) => {
    if (!container) return;
    
    // Vider les liens existants d'auth
    const oldAuthLinks = container.querySelectorAll('[data-auth-link]');
    oldAuthLinks.forEach(link => link.remove());
    
    if (authStatus.loggedIn) {
      // ✅ Afficher le nom d'utilisateur avec icône
      const userInfo = document.createElement('div');
      userInfo.setAttribute('data-auth-link', 'true');
      userInfo.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        margin-right: 12px;
        font-size: 14px;
        font-weight: 600;
        color: white;
      `;
      
      // ✅ Ensure userName is a string
      const userName = typeof authStatus.user.name === 'string' 
        ? authStatus.user.name 
        : (authStatus.user.name?.first_name 
          ? `${authStatus.user.name.first_name} ${authStatus.user.name.last_name || ''}`.trim()
          : authStatus.user.email);
      
      userInfo.innerHTML = `
        <span>👤 ${userName}</span>
      `;
      container.appendChild(userInfo);
      
      // ✅ Bouton Tableau de bord
      const dashboardLink = document.createElement('a');
      dashboardLink.href = getDashboardByRole(authStatus?.user?.role);
      dashboardLink.className = 'nav-link';
      dashboardLink.setAttribute('data-auth-link', 'true');
      dashboardLink.style.cssText = `
        padding: 8px 16px;
        background: rgba(102, 126, 234, 0.1);
        border-radius: 6px;
        text-decoration: none;
        color: white;
        font-weight: 600;
        transition: all 0.3s ease;
      `;
      dashboardLink.innerHTML = '📊 Tableau de bord';
      container.appendChild(dashboardLink);
      
      // ✅ Bouton Déconnexion
      const logoutLink = document.createElement('a');
      logoutLink.href = '#';
      logoutLink.className = 'nav-link';
      logoutLink.setAttribute('data-auth-link', 'true');
      logoutLink.style.cssText = `
        padding: 8px 16px;
        background: #ff4444;
        color: white;
        border-radius: 6px;
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
      `;
      logoutLink.innerHTML = '🚪 Déconnexion';
      logoutLink.onclick = (e) => {
        e.preventDefault();
        logout();
      };
      container.appendChild(logoutLink);
    } else {
      // ✅ Afficher les liens Login/Signup
      const loginLink = document.createElement('a');
      loginLink.href = 'login.html';
      loginLink.className = 'nav-link';
      loginLink.setAttribute('data-auth-link', 'true');
      loginLink.style.cssText = `
        padding: 8px 16px;
        background: var(--primary);
        color: white;
        border-radius: 6px;
        text-decoration: none;
        font-weight: 600;
        transition: all 0.3s ease;
      `;
      loginLink.textContent = '🔑 Connexion';
      container.appendChild(loginLink);
      
      const signupLink = document.createElement('a');
      signupLink.href = 'inscription.html';
      signupLink.className = 'nav-link';
      signupLink.setAttribute('data-auth-link', 'true');
      signupLink.style.cssText = `
        padding: 8px 16px;
        border: 2px solid white;
        color: white;
        border-radius: 6px;
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
      `;
      signupLink.textContent = '✍️ Inscription';
      container.appendChild(signupLink);
    }
  };
  
  // Appliquer aux deux navbars
  if (navLinks) addAuthElements(navLinks);
  if (navUnified) addAuthElements(navUnified);
  
  // ✅ Auto-redirect from login page if already authenticated
  if (window.location.pathname.includes('login.html') && authStatus.loggedIn) {
    const redirect = sessionStorage.getItem('redirectAfterLogin') || getDashboardByRole(authStatus?.user?.role);
    sessionStorage.removeItem('redirectAfterLogin');
    setTimeout(() => window.location.href = redirect, 500);
  }
}

// ✅ Ajouter les protections sur les boutons d'action
function addAuthProtection() {
  // Bouton "Publier une propriété"
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

  // ✅ Auth check for buy button is handled inside detail.js setupPurchaseModal()
  // (checks auth before opening modal, redirects to login if needed)

  // ✅ Auth check for rent button is handled inside detail.js setupReservationModal()
  // (checks auth before opening modal, redirects to login if needed)

  // ✅ Visiter button
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
