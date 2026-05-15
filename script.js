// Plus besoin de token ici - le serveur proxy s'en charge
const API_URL = "/api/properties";
let allProperties = []; // Store all properties for dynamic filtering

function normalizeImageUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('/api/media?') || trimmed.startsWith('/api/property-image/') || trimmed.startsWith('/uploads/') || trimmed.startsWith('data:image/')) {
    return trimmed;
  }

  if (trimmed.startsWith('/api/v2') || trimmed.startsWith('/api/v2.1')) {
    return `/api/media?url=${encodeURIComponent(`https://creator.zoho.com${trimmed}`)}`;
  }

  if (trimmed.startsWith('//')) {
    return `/api/media?url=${encodeURIComponent(`https:${trimmed}`)}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const isZohoApi = /https?:\/\/(creator\.zoho\.com|creatorapp\.zoho\.com)\/api\//i.test(trimmed);
    return isZohoApi ? `/api/media?url=${encodeURIComponent(trimmed)}` : trimmed;
  }

  return null;
}

function resolveImageUrl(property) {
  const raw =
    property.image_proxy_url ||
    property.image_url ||
    property.Image ||
    property.image ||
    property.Images ||
    property.images ||
    property.Photo ||
    property.photo ||
    property.Photos ||
    property.photos ||
    property.zc_display_value;
  if (!raw) return null;
  if (typeof raw === 'string') return normalizeImageUrl(raw);
  if (Array.isArray(raw) && raw.length > 0) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const normalized = normalizeImageUrl(item);
        if (normalized) return normalized;
        continue;
      }
      const candidate = item?.download_url || item?.url || item?.content || item?.display_value || item?.zc_display_value || null;
      const normalized = normalizeImageUrl(candidate);
      if (normalized) return normalized;
    }
    return null;
  }
  if (typeof raw === 'object') {
    return normalizeImageUrl(raw.download_url || raw.url || raw.content || raw.display_value || raw.zc_display_value || null);
  }
  return null;
}

function resolveLocationText(location) {
  if (!location) return "N/A";

  if (typeof location === 'string') {
    const trimmed = location.trim();
    return trimmed || "N/A";
  }

  if (typeof location === 'object') {
    const directDisplay = [
      location.display_value,
      location.zc_display_value,
      location.district_city,
      location.City_District
    ].find((value) => typeof value === 'string' && value.trim());

    if (directDisplay) {
      return directDisplay.trim();
    }

    const composed = [
      location.address_line_1,
      location.address_line_2,
      location.district_city || location.City_District
    ]
      .filter((value) => typeof value === 'string' && value.trim())
      .join(', ');

    return composed || "N/A";
  }

  return "N/A";
}

async function loadProperties() {
  const container = document.getElementById("propertiesContainer");
  container.innerHTML = "<p>Chargement des propriétés...</p>";

  try {
    const response = await fetch(`${API_URL}?limit=12`);

    if (!response.ok) {
      throw new Error(`Erreur serveur: ${response.statusText}`);
    }

    const result = await response.json();
    console.log("✅ Propriétés chargées:", result.data.length);

    if (!result.data || result.data.length === 0) {
      container.innerHTML = "<p style='text-align:center;color:#999;padding:40px;'>Aucun bien trouvé pour le moment.</p>";
      return;
    }

    // ✅ Limit to latest 12 properties
    allProperties = result.data.slice(0, 12);
    console.log("📌 Affichage des 12 plus récentes annonces");
    
    // Display latest 12 properties
    displayProperties(allProperties);
    
    // Setup dynamic search
    setupDynamicSearch();

  } catch(error) {
    console.error("Erreur complète:", error);
    container.innerHTML = `<p style='color:red;text-align:center;padding:40px;'>⚠️ Erreur chargement: ${error.message}</p>`;
  }
}

function displayProperties(properties) {
  const container = document.getElementById("propertiesContainer");
  
  if (!properties || properties.length === 0) {
    container.innerHTML = "<p>Aucun bien trouvé.</p>";
    return;
  }

  container.innerHTML = properties.map((property, index) => {
    const title = property.title || "Sans titre";
    const description = property.description || "";
    const location = resolveLocationText(property.location);
    const status = property.status || "N/A";
    const type = property.type_field || "N/A";
    const typeLower = type.toLowerCase();
    const priceParts = [];
    if (typeLower.includes('courte') && property.prix_nuit) priceParts.push(`${property.prix_nuit} DT/nuit`);
    if (typeLower.includes('longue') && property.loyer_mensuel) priceParts.push(`${property.loyer_mensuel} DT/mois`);
    if ((typeLower.includes('vente') || typeLower.includes('achat')) && property.Price1) priceParts.push(`${property.Price1} DT`);
    if (priceParts.length === 0 && property.Price1) priceParts.push(`${property.Price1} DT`);
    const price = priceParts.length > 0 ? priceParts.join(' · ') : 'Prix non renseigné';
    const image = resolveImageUrl(property);
    const propertyRef = property.ID || property.ID1 || '';

    // Déterminer le badge de statut
    const badgeClass = status.toLowerCase().includes("location") ? "badge-location" : "badge-vente";

    return `
      <a href="detail.html?id=${encodeURIComponent(propertyRef)}" class="card-link">
        <div class="card">
          <div class="card-img">${image ? `<img src="${image}" alt="${title}" style="width:100%;height:100%;object-fit:cover;">` : '🏠 Photo'}</div>
          <div class="card-badge-top ${badgeClass}">${status}</div>
          <div class="card-body">
            <h4 class="card-title">${title}</h4>
            <p class="card-loc">📍 ${location}</p>
            <div class="card-specs">
              <span>🏷️ ${type}</span>
            </div>
            <p class="card-price">${price}</p>
            <p style="font-size:12px;color:#999;margin-top:8px">${description.substring(0, 100)}...</p>
          </div>
        </div>
      </a>
    `;
  }).join("");
}

function setupDynamicSearch() {
  const searchInput = document.querySelector('.search-input');
  const searchBtn = document.querySelector('.search-btn');

  if (!searchInput) return;

  // ✅ Search button redirects to annonces.html with query parameter
  if (searchBtn) {
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const searchQuery = searchInput.value.trim();
      if (searchQuery) {
        window.location.href = `annonces.html?search=${encodeURIComponent(searchQuery)}`;
      } else {
        window.location.href = 'annonces.html';
      }
    });
  }

  // Also redirect on Enter key
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const searchQuery = searchInput.value.trim();
      if (searchQuery) {
        window.location.href = `annonces.html?search=${encodeURIComponent(searchQuery)}`;
      } else {
        window.location.href = 'annonces.html';
      }
    }
  });
}

// Search now redirects to annonces.html - see setupDynamicSearch()

// Charger les propriétés et initialiser l'auth au chargement de la page
document.addEventListener("DOMContentLoaded", async () => {
  loadProperties();
  updateNavbarAuth(); // ✅ Afficher le status d'authentification
  addAuthProtection(); // ✅ Ajouter la protection d'auth aux boutons
});
