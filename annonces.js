const API_URL = "/api/properties";
let allProperties = []; // Store all properties for filtering
let filteredProperties = [];
let currentFilter = 'tous'; // Track active filter
let currentPage = 1;
const PAGE_SIZE = 24;

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

function resolvePrice(property) {
  const type = (property.type_field || '').toLowerCase();
  const parts = [];
  if (type.includes('courte') && property.prix_nuit) parts.push(`${property.prix_nuit} DT/nuit`);
  if (type.includes('longue') && property.loyer_mensuel) parts.push(`${property.loyer_mensuel} DT/mois`);
  if ((type.includes('vente') || type.includes('achat')) && property.Price1) parts.push(`${property.Price1} DT`);
  if (parts.length === 0 && property.Price1) parts.push(`${property.Price1} DT`);
  return parts.length > 0 ? parts.join(' · ') : 'Prix non renseigné';
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

async function loadListings() {
  const listingsContainer = document.querySelector('.listings');
  listingsContainer.innerHTML = "<p style='text-align:center'>Chargement des annonces...</p>";

  try {
    const response = await fetch(`${API_URL}?limit=200`);

    if (!response.ok) {
      throw new Error(`Erreur serveur: ${response.statusText}`);
    }

    const result = await response.json();
    console.log("✅ Annonces chargées:", result.data.length);

    if (!result.data || result.data.length === 0) {
      listingsContainer.innerHTML = "<p style='text-align:center'>Aucun bien trouvé.</p>";
      return;
    }

    // Store properties globally for filtering
    allProperties = result.data;
    filteredProperties = result.data;

    // ✅ Check for search parameter in URL and apply it
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('search');
    
    if (searchQuery) {
      console.log(`🔍 Recherche pour: "${searchQuery}"`);
      filterProperties(searchQuery);
    } else {
      // Display all properties initially
      displayProperties(allProperties);
    }

    // Setup filters and search
    setupFilters();
    setupSearch();

  } catch(error) {
    listingsContainer.innerHTML = `<p style="color:red;text-align:center">Erreur: ${error.message}</p>`;
    console.error("Erreur:", error);
  }
}

function renderPaginationControls(totalItems) {
  const container = document.getElementById('paginationControls');
  if (!container) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (totalItems <= PAGE_SIZE) {
    container.innerHTML = '';
    return;
  }

  const prevDisabled = currentPage <= 1 ? 'disabled' : '';
  const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

  container.innerHTML = `
    <button type="button" data-page-action="prev" ${prevDisabled} style="padding:10px 14px;border:none;border-radius:999px;background:var(--primary);color:#fff;cursor:pointer;opacity:${prevDisabled ? '0.5' : '1'}">Précédent</button>
    <span style="font-weight:600;color:var(--primary)">Page ${currentPage} / ${totalPages}</span>
    <button type="button" data-page-action="next" ${nextDisabled} style="padding:10px 14px;border:none;border-radius:999px;background:var(--primary);color:#fff;cursor:pointer;opacity:${nextDisabled ? '0.5' : '1'}">Suivant</button>
  `;

  const prevBtn = container.querySelector('[data-page-action="prev"]');
  const nextBtn = container.querySelector('[data-page-action="next"]');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage -= 1;
        displayProperties(filteredProperties);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage += 1;
        displayProperties(filteredProperties);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
}

function displayProperties(properties, groupByCity = false) {
  const listingsContainer = document.querySelector('.listings');
  const paginationContainer = document.getElementById('paginationControls');
  
  if (!properties || properties.length === 0) {
    listingsContainer.innerHTML = "<p style='text-align:center'>Aucun bien trouvé.</p>";
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  filteredProperties = properties;

  // ✅ Group by city if needed
  if (groupByCity) {
    if (paginationContainer) paginationContainer.innerHTML = '';
    displayGroupedByCity(properties);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(properties.length / PAGE_SIZE));
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }

  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageProperties = properties.slice(pageStart, pageStart + PAGE_SIZE);

  listingsContainer.innerHTML = pageProperties.map((property, index) => {
    const title = property.title || "Sans titre";
    const description = property.description || "";
    const location = resolveLocationText(property.location);
    const price = resolvePrice(property);
    const status = property.status || "N/A";
    const type = property.type_field || "N/A";
    const image = resolveImageUrl(property);
    const propertyRef = property.ID || property.ID1 || '';

    // Déterminer la couleur du badge
    const badgeColor = type.toLowerCase().includes("location") ? "var(--accent)" : "var(--primary)";
    const badgeStyle = `background:${badgeColor};color:#fff;font-size:10px;padding:4px 10px;border-radius:var(--radius-sm);font-weight:600`;

    return `
      <article class="listing-card" data-status="${status}" data-title="${title.toLowerCase()}" data-location="${String(location).toLowerCase()}" data-type="${type.toLowerCase()}">
        <div class="listing-img">
          <span style="position:absolute;top:10px;left:10px;${badgeStyle}">${type}</span>
          ${image ? `<img src="${image}" alt="${title}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.insertAdjacentHTML('beforeend','<span style=\'display:flex;align-items:center;justify-content:center;height:100%;font-size:40px;\'>🏠</span>')">` : '🏠 Photo'}
        </div>
        <div class="listing-body">
          <h3 class="listing-title">${title}</h3>
          <div class="listing-details">
            <span class="listing-detail">🏷️ ${type}</span>
            <span class="listing-detail">📍 ${location}</span>
          </div>
          <p class="listing-price">${price}</p>
          <p style="font-size:12px;color:#999;margin:8px 0">${description.substring(0, 80)}...</p>
          <a href="detail.html?id=${encodeURIComponent(propertyRef)}" class="cta-btn" style="margin:10px 0 0;padding:8px;font-size:13px;text-align:center;display:block">Voir le bien</a>
        </div>
      </article>
    `;
  }).join("");

  renderPaginationControls(properties.length);

  // Re-attach click handlers
  attachCardClickHandlers();
}

// ✅ Group properties by city
function displayGroupedByCity(properties) {
  const listingsContainer = document.querySelector('.listings');
  
  // Create a map of cities with their properties
  const citiesMap = {};
  properties.forEach(property => {
    const city = resolveLocationText(property.location) || "Autre";
    if (!citiesMap[city]) {
      citiesMap[city] = [];
    }
    citiesMap[city].push(property);
  });

  // Sort cities alphabetically
  const sortedCities = Object.keys(citiesMap).sort();

  // Generate HTML with city headers and grouped properties
  let html = '';
  sortedCities.forEach(city => {
    html += `<div style="margin-bottom:32px;">
      <h2 style="font-size:20px;font-weight:700;color:var(--primary);padding:16px 0;border-bottom:2px solid var(--primary);margin-bottom:16px">${city}</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
        ${citiesMap[city].map((property, index) => {
          const title = property.title || "Sans titre";
          const description = property.description || "";
          const location = resolveLocationText(property.location);
          const price = resolvePrice(property);
          const type = property.type_field || "N/A";
          const image = resolveImageUrl(property);
          const propertyRef = property.ID || property.ID1 || '';

          const badgeColor = type.toLowerCase().includes("location") ? "var(--accent)" : "var(--primary)";
          const badgeStyle = `background:${badgeColor};color:#fff;font-size:10px;padding:4px 10px;border-radius:var(--radius-sm);font-weight:600`;

          return `
            <article class="listing-card" data-status="${property.status || 'N/A'}" data-title="${title.toLowerCase()}" data-location="${String(location).toLowerCase()}" data-type="${type.toLowerCase()}">
              <div class="listing-img">
                <span style="position:absolute;top:10px;left:10px;${badgeStyle}">${type}</span>
                ${image ? `<img src="${image}" alt="${title}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.insertAdjacentHTML('beforeend','<span style=\'display:flex;align-items:center;justify-content:center;height:100%;font-size:40px;\'>🏠</span>')">` : '🏠 Photo'}
              </div>
              <div class="listing-body">
                <h3 class="listing-title">${title}</h3>
                <div class="listing-details">
                  <span class="listing-detail">🏷️ ${type}</span>
                  <span class="listing-detail">📍 ${location}</span>
                </div>
                <p class="listing-price">${price}</p>
                <p style="font-size:12px;color:#999;margin:8px 0">${description.substring(0, 80)}...</p>
                <a href="detail.html?id=${encodeURIComponent(propertyRef)}" class="cta-btn" style="margin:10px 0 0;padding:8px;font-size:13px;text-align:center;display:block">Voir le bien</a>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </div>`;
  });

  listingsContainer.innerHTML = html;
  attachCardClickHandlers();
}

function setupSearch() {
  const searchInput = document.querySelector('.search-input');
  const searchBtn = document.querySelector('.search-btn');
  
  if (!searchInput) return;

  // ✅ Set search input to current URL parameter if present
  const urlParams = new URLSearchParams(window.location.search);
  const currentSearch = urlParams.get('search');
  if (currentSearch) {
    searchInput.value = currentSearch;
  }

  // Real-time search as user types
  searchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase().trim();
    filterProperties(searchTerm);
  });

  // ✅ Search button redirects with new search parameter
  if (searchBtn) {
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const searchTerm = searchInput.value.trim();
      if (searchTerm) {
        window.location.href = `annonces.html?search=${encodeURIComponent(searchTerm)}`;
      } else {
        window.location.href = 'annonces.html';
      }
    });
  }

  // Also search on Enter key
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const searchTerm = searchInput.value.trim();
      if (searchTerm) {
        window.location.href = `annonces.html?search=${encodeURIComponent(searchTerm)}`;
      } else {
        window.location.href = 'annonces.html';
      }
    }
  });
}

function filterProperties(searchTerm) {
  currentPage = 1;
  let filtered = allProperties;
  let groupByCity = false;

  // Get active filter chip — read data-filter attribute, not textContent
  const activeChip = document.querySelector('.filter-chip.active');
  const activeFilter = activeChip ? (activeChip.dataset.filter || 'all') : 'all';
  currentFilter = activeFilter;

  // Filter by type
  if (activeFilter === 'courte') {
    filtered = filtered.filter(p => (p.type_field || '').toLowerCase().includes('courte'));
  } else if (activeFilter === 'longue') {
    filtered = filtered.filter(p => (p.type_field || '').toLowerCase().includes('longue'));
  } else if (activeFilter === 'achat') {
    filtered = filtered.filter(p => {
      const t = (p.type_field || '').toLowerCase();
      return t.includes('vente') || t.includes('achat');
    });
  }
  // 'all' shows everything

  // ✅ Filter by search term (title, description, location, type)
  if (searchTerm) {
    filtered = filtered.filter(property => {
      const title = (property.title || "").toLowerCase();
      const description = (property.description || "").toLowerCase();
      const location = resolveLocationText(property.location).toLowerCase();
      const type = (property.type_field || "").toLowerCase();
      const price = resolvePrice(property).toLowerCase();

      return title.includes(searchTerm) ||
             description.includes(searchTerm) ||
             location.includes(searchTerm) ||
             type.includes(searchTerm) ||
             price.includes(searchTerm);
    });
  }

  // Display filtered results
  displayProperties(filtered, groupByCity);
  
  // Update result count
  const searchInput = document.querySelector('.search-input');
  if (searchTerm && searchInput) {
    console.log(`🔍 Résultats de recherche: ${filtered.length} bien(s) trouvé(s)`);
  }
}

function setupFilters() {
  const filterChips = document.querySelectorAll('.filter-chip');

  filterChips.forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();

      // Remove active state from all chips
      filterChips.forEach(c => c.classList.remove('active'));

      // Add active state to clicked chip
      e.target.classList.add('active');

      // Get search term from input
      const searchInput = document.querySelector('.search-input');
      const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

      // ✅ Trigger filtering with current search term and new filter
      filterProperties(searchTerm);
    });
  });
}

function attachCardClickHandlers() {
  const cards = document.querySelectorAll('.listing-card');
  cards.forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.cta-btn')) return; // Don't redirect if clicking button
      const link = card.querySelector('.cta-btn');
      if (link) window.location.href = link.href;
    });
  });
}

// Charger les annonces et mettre à jour le navbar au chargement de la page
document.addEventListener("DOMContentLoaded", async () => {
  loadListings();
  updateNavbarAuth(); // ✅ Afficher le status d'authentification et logout button
});
