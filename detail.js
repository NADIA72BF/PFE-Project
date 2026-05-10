const API_URL = "/api/properties";
let currentProperty = null; // Store current property for reservation
let galleryState = {
  images: [],
  currentIndex: 0,
  touchStartX: 0,
  touchEndX: 0
};

function isLikelyImageUrl(value) {
  if (typeof value !== 'string') return false;
  return (
    /^https?:\/\//i.test(value) ||
    value.startsWith('/api/') ||
    value.startsWith('/uploads/') ||
    value.startsWith('data:image/')
  );
}

function extractImageUrlsFromValue(value) {
  if (!value) return [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return extractImageUrlsFromValue(JSON.parse(trimmed));
      } catch (_) {
        // Keep fallback handling below.
      }
    }

    return isLikelyImageUrl(trimmed) ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractImageUrlsFromValue);
  }

  if (typeof value === 'object') {
    const candidates = [
      value.download_url,
      value.url,
      value.content,
      value.display_value,
      value.zc_display_value,
      value.filepath,
      value.image,
      value.Image
    ];
    return candidates.flatMap(extractImageUrlsFromValue);
  }

  return [];
}

function normalizeImageUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Already usable local URLs.
  if (
    trimmed.startsWith('/api/property-image/') ||
    trimmed.startsWith('/api/media?') ||
    trimmed.startsWith('/uploads/') ||
    trimmed.startsWith('data:image/')
  ) {
    return trimmed;
  }

  // Zoho relative API paths must be proxied via /api/media.
  if (trimmed.startsWith('/api/v2') || trimmed.startsWith('/api/v2.1')) {
    return `/api/media?url=${encodeURIComponent(`https://creator.zoho.com${trimmed}`)}`;
  }

  // Protocol-relative links (e.g. //creator.zoho.com/...).
  if (trimmed.startsWith('//')) {
    return `/api/media?url=${encodeURIComponent(`https:${trimmed}`)}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const isZohoApi = /https?:\/\/(creator\.zoho\.com|creatorapp\.zoho\.com)\/api\//i.test(trimmed);
    return isZohoApi ? `/api/media?url=${encodeURIComponent(trimmed)}` : trimmed;
  }

  return null;
}

function resolveImageUrls(property) {
  if (!property) return [];

  const collectionValues = [
    property.Image,
    property.image,
    property.Images,
    property.images,
    property.Photo,
    property.photo,
    property.Photos,
    property.photos
  ];

  const fallbackValues = [
    property.image_proxy_url,
    property.image_url,
    property.zc_display_value
  ];

  const uniqueUrls = [];
  const seen = new Set();

  const appendNormalizedUrls = (rawValues) => {
    for (const raw of rawValues) {
      const urls = extractImageUrlsFromValue(raw);
      for (const rawUrl of urls) {
        const url = normalizeImageUrl(rawUrl);
        if (url && !seen.has(url)) {
          seen.add(url);
          uniqueUrls.push(url);
        }
      }
    }
  };

  // If a real image collection exists, use it as the source of truth.
  appendNormalizedUrls(collectionValues);

  if (uniqueUrls.length === 0) {
    appendNormalizedUrls(fallbackValues);
  }

  if (uniqueUrls.length === 0 && property.ID) {
    uniqueUrls.push(`/api/property-image/${property.ID}`);
  }

  return uniqueUrls;
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

function updateGalleryPosition() {
  const track = document.querySelector('.detail-gallery-track');
  const dots = document.querySelectorAll('.detail-gallery-dot');
  const counter = document.getElementById('galleryCounter');

  if (!track) return;
  track.style.transform = `translateX(-${galleryState.currentIndex * 100}%)`;

  dots.forEach((dot, index) => {
    dot.classList.toggle('active', index === galleryState.currentIndex);
  });

  if (counter) {
    counter.textContent = `${galleryState.currentIndex + 1}/${galleryState.images.length}`;
  }
}

function renderPropertyGallery(images, title) {
  const container = document.querySelector('.detail-img');
  if (!container) return;

  if (!Array.isArray(images) || images.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:20px">Aucune photo disponible</div>';
    return;
  }

  galleryState = {
    images,
    currentIndex: 0,
    touchStartX: 0,
    touchEndX: 0
  };

  const slides = images
    .map((imageUrl, index) => `<img class="detail-gallery-image" src="${imageUrl}" alt="${title} - Photo ${index + 1}">`)
    .join('');

  const dots = images
    .map((_, index) => `<button type="button" class="detail-gallery-dot${index === 0 ? ' active' : ''}" data-index="${index}" aria-label="Photo ${index + 1}"></button>`)
    .join('');

  container.innerHTML = `
    <div class="detail-gallery-wrapper">
      <div class="detail-gallery-track">${slides}</div>
      ${images.length > 1 ? '<button type="button" class="detail-gallery-nav prev" aria-label="Image précédente">&#10094;</button>' : ''}
      ${images.length > 1 ? '<button type="button" class="detail-gallery-nav next" aria-label="Image suivante">&#10095;</button>' : ''}
      <div class="detail-gallery-counter" id="galleryCounter">1/${images.length}</div>
      ${images.length > 1 ? `<div class="detail-gallery-dots">${dots}</div>` : ''}
    </div>
  `;

  const track = container.querySelector('.detail-gallery-track');
  const prevBtn = container.querySelector('.detail-gallery-nav.prev');
  const nextBtn = container.querySelector('.detail-gallery-nav.next');
  const dotButtons = container.querySelectorAll('.detail-gallery-dot');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      galleryState.currentIndex = (galleryState.currentIndex - 1 + galleryState.images.length) % galleryState.images.length;
      updateGalleryPosition();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      galleryState.currentIndex = (galleryState.currentIndex + 1) % galleryState.images.length;
      updateGalleryPosition();
    });
  }

  dotButtons.forEach((dot) => {
    dot.addEventListener('click', () => {
      galleryState.currentIndex = Number(dot.dataset.index) || 0;
      updateGalleryPosition();
    });
  });

  if (track && images.length > 1) {
    track.addEventListener('touchstart', (event) => {
      galleryState.touchStartX = event.changedTouches[0].screenX;
    }, { passive: true });

    track.addEventListener('touchend', (event) => {
      galleryState.touchEndX = event.changedTouches[0].screenX;
      const delta = galleryState.touchEndX - galleryState.touchStartX;

      if (Math.abs(delta) < 40) return;

      if (delta < 0) {
        galleryState.currentIndex = (galleryState.currentIndex + 1) % galleryState.images.length;
      } else {
        galleryState.currentIndex = (galleryState.currentIndex - 1 + galleryState.images.length) % galleryState.images.length;
      }
      updateGalleryPosition();
    }, { passive: true });
  }

  updateGalleryPosition();
}

async function loadPropertyDetails() {
  // Récupérer l'ID depuis l'URL
  const urlParams = new URLSearchParams(window.location.search);
  const propertyId = urlParams.get('id');

  // Mettre à jour les data-property-id sur les boutons d'action
  const actionButtons = document.querySelectorAll('[data-action]');
  actionButtons.forEach(btn => {
    btn.setAttribute('data-property-id', propertyId || '');
  });

  // Afficher un loader immédiatement
  const detailBody = document.querySelector('.detail-body');
  detailBody.innerHTML = '<p style="text-align:center;color:var(--gray-600)">Chargement des détails...</p>';

  if (!propertyId) {
    detailBody.innerHTML = "<p style='color:red'>Erreur: Propriété introuvable</p>";
    return;
  }

  try {
    const response = await fetch(`${API_URL}/${encodeURIComponent(propertyId)}`);

    if (!response.ok) {
      throw new Error(`Erreur serveur: ${response.statusText}`);
    }

    const result = await response.json();
    const property = (result.data || [null])[0];

    if (!property) {
      detailBody.innerHTML = "<p style='color:red'>Propriété introuvable</p>";
      return;
    }

    // Store for later use
    currentProperty = property;

    // Remplir les détails
    displayPropertyDetails(property);
    setupReservationModal(property);
    setupPurchaseModal(property);

  } catch(error) {
    console.error("Erreur:", error);
    detailBody.innerHTML = `<p style="color:red">Erreur: ${error.message}</p>`;
  }
}

function displayPropertyDetails(property) {
  // Récupérer les données
  const title = property.title || "Sans titre";
  const location = resolveLocationText(property.location);
  const price = property.Price1 || "N/A";
  const status = property.status || "N/A";
  const description = property.description || "Pas de description disponible";
  const type = property.type_field || "N/A";
  const images = resolveImageUrls(property);

  // Mettre à jour le titre de la page
  document.title = `GI Immobilier — ${title}`;

  // Afficher toutes les images en galerie
  renderPropertyGallery(images, title);

  // Déterminer la couleur du badge
  const badgeColor = type.toLowerCase().includes('to rent') ? 'var(--success)' : 'var(--accent)';

  // Reconstruire complètement le contenu
  const detailBody = document.querySelector('.detail-body');
  detailBody.innerHTML = `
    <span style="
      display: inline-block;
      background: ${badgeColor};
      color: white;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 12px;
    ">${type}</span>
    
    <h1 class="detail-title" style="font-size:32px;font-weight:700;margin:12px 0">${title} — ${location}</h1>
    <p class="detail-price" style="font-size:28px;font-weight:700;color:var(--accent);margin:12px 0">${price} DT</p>

    <div class="detail-specs" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0">
      <div class="spec" style="text-align:center;padding:16px;background:var(--gray-50);border-radius:8px">
        <div class="spec-num" style="font-size:20px;font-weight:700">${type}</div>
        <div class="spec-label" style="font-size:12px;color:var(--gray-600)">Type</div>
      </div>
      <div class="spec" style="text-align:center;padding:16px;background:var(--gray-50);border-radius:8px">
        <div class="spec-num" style="font-size:20px;font-weight:700">${status}</div>
        <div class="spec-label" style="font-size:12px;color:var(--gray-600)">Statut</div>
      </div>
      <div class="spec" style="text-align:center;padding:16px;background:var(--gray-50);border-radius:8px">
        <div class="spec-num" style="font-size:20px;font-weight:700">📍</div>
        <div class="spec-label" style="font-size:12px;color:var(--gray-600)">${location}</div>
      </div>
      <div class="spec" style="text-align:center;padding:16px;background:var(--gray-50);border-radius:8px">
        <div class="spec-num" style="font-size:14px;font-weight:700">ID: ${property.ID}</div>
        <div class="spec-label" style="font-size:12px;color:var(--gray-600)">Référence</div>
      </div>
    </div>

    <p style="font-size:14px;color:var(--gray-700);margin-top:16px;line-height:1.6;">
      ${description}
    </p>
  `;
}

// ✅ Setup reservation modal
function setupReservationModal(property) {
  const modal = document.getElementById('reservationModal');
  const closeModalBtn = document.getElementById('closeModal');
  const rentBtn = document.querySelector('[data-action="rent-property"]');
  const reservationForm = document.getElementById('reservationForm');
  const startDateInput = document.getElementById('reservationStartDate');
  const endDateInput = document.getElementById('reservationEndDate');
  const estimatedDuration = document.getElementById('estimatedDuration');
  const messageDiv = document.getElementById('reservationMessage');

  console.log(`🔍 Looking for rent button...`);
  console.log(`📦 rentBtn element found:`, rentBtn);
  console.log(`🎯 modal element found:`, modal);
  console.log(`📋 reservationForm element found:`, reservationForm);
  
  // Only show rent button if property is for rent
  const typeField = (property.type_field || "").toLowerCase().trim();
  console.log(`📋 Property type_field: "${property.type_field}"`);
  console.log(`🏠 Is rental (includes 'to rent'): ${typeField.includes('to rent')}`);
  
  if (!rentBtn) {
    console.warn(`⚠️ WARNING: Rent button not found in DOM!`);
    return;
  }

  if (!modal) {
    console.warn(`⚠️ WARNING: Modal not found in DOM!`);
    return;
  }

  const isRental = typeField.includes('to rent');
  
  if (isRental) {
    rentBtn.style.display = 'block';
    rentBtn.style.visibility = 'visible';
    rentBtn.style.opacity = '1';
    console.log(`✅ Rent button SHOWN`);
  } else {
    rentBtn.style.display = 'none';
    console.log(`❌ Rent button HIDDEN`);
    return;
  }

  // ✅ ATTACH CLICK EVENT TO OPEN MODAL
  rentBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log(`🖱️ Rent button CLICKED!`);
    
    // Check authentication FIRST
    const authStatus = await fetch('/api/auth-status').then(r => r.json());
    if (!authStatus.loggedIn) {
      console.log(`🔒 Not logged in - redirecting to login`);
      window.location.href = `login.html?redirect=detail.html?id=${property.ID}`;
      return;
    }
    
    console.log(`✅ User authenticated - opening modal`);
    messageDiv.className = '';
    messageDiv.style.display = 'none';
    if (reservationForm) reservationForm.reset();
    if (estimatedDuration) estimatedDuration.textContent = '—';
    modal.style.display = 'flex';
    console.log(`🎉 Modal opened (display: flex)`);
  });

  // Close modal with X button
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log(`🔒 Close button clicked`);
      modal.style.display = 'none';
    });
  }

  // Close modal with ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      console.log(`⌨️ ESC key pressed - closing modal`);
      modal.style.display = 'none';
    }
  });

  // ✅ Calculate duration when dates change
  const calculateDuration = () => {
    const startDate = new Date(startDateInput.value);
    const endDate = new Date(endDateInput.value);

    if (startDateInput.value && endDateInput.value && startDate <= endDate) {
      const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      if (days === 1) {
        estimatedDuration.textContent = '1 jour';
      } else {
        estimatedDuration.textContent = `${days} jours`;
      }
    } else {
      estimatedDuration.textContent = '—';
    }
  };

  startDateInput.addEventListener('change', calculateDuration);
  endDateInput.addEventListener('change', calculateDuration);

  // ✅ Submit reservation
  reservationForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log(`📤 Reservation form submitted`);

    const startDate = startDateInput.value;
    const endDate = endDateInput.value;

    // Client-side validation
    if (!startDate || !endDate) {
      messageDiv.className = 'error-alert';
      messageDiv.innerHTML = '⚠️ Veuillez remplir les dates de début et de fin';
      messageDiv.style.display = 'block';
      return;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > end) {
      messageDiv.className = 'error-alert';
      messageDiv.innerHTML = '⚠️ La date de fin doit être après la date de début';
      messageDiv.style.display = 'block';
      return;
    }

    // Check authentication
    const authStatus = await fetch('/api/auth-status').then(r => r.json());
    if (!authStatus.loggedIn) {
      messageDiv.className = 'error-alert';
      messageDiv.innerHTML = '⚠️ Vous devez être connecté pour faire une réservation';
      messageDiv.style.display = 'block';
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1500);
      return;
    }

    try {
      const submitBtn = reservationForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.7';

      const response = await fetch('/api/reservations/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          property_id: property.ID,
          property_title: property.title,
          start_date: startDate,
          end_date: endDate
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        messageDiv.className = 'success-alert';
        messageDiv.innerHTML = '✓ Réservation confirmée! Redirection en cours...';
        messageDiv.style.display = 'block';

        setTimeout(() => {
          modal.style.display = 'none';
          window.location.href = 'user_reservations.html';
        }, 2000);
      } else {
        messageDiv.className = 'error-alert';
        messageDiv.innerHTML = `⚠️ ${data.error || 'Erreur lors de la création de la réservation'}`;
        messageDiv.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
      }
    } catch (error) {
      messageDiv.className = 'error-alert';
      messageDiv.innerHTML = `⚠️ Erreur réseau: ${error.message}`;
      messageDiv.style.display = 'block';
      const submitBtn = reservationForm.querySelector('button[type="submit"]');
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
    }
  });
}

// ✅ Setup purchase modal (Demande d'achat)
function setupPurchaseModal(property) {
  console.log('🛒 setupPurchaseModal() called for property:', property?.ID, '| type_field:', property?.type_field);

  const modal = document.getElementById('purchaseModal');
  const closeBtn = document.getElementById('closePurchaseModal');
  const buyBtn = document.querySelector('[data-action="buy-property"]');
  const form = document.getElementById('purchaseForm');
  const msgDiv = document.getElementById('purchaseMessage');
  const priceDisplay = document.getElementById('purchasePriceDisplay');

  if (!modal) { console.warn('⚠️ #purchaseModal not found in DOM'); return; }
  if (!buyBtn) { console.warn('⚠️ [data-action="buy-property"] not found in DOM'); return; }
  if (!form)   { console.warn('⚠️ #purchaseForm not found in DOM'); return; }

  // ── Visibility logic ─────────────────────────────────────────
  const typeField = (property.type_field || '').toLowerCase().trim();
  const isSale = typeField.includes('for sale') || typeField.includes('vente') || typeField.includes('sale');

  console.log(`🏷️ type_field="${property.type_field}" → isSale=${isSale}`);

  if (!isSale) {
    buyBtn.style.display = 'none';
    console.log('❌ Demande d\'achat button HIDDEN (not a sale property)');
    return;
  }

  buyBtn.textContent = "Demande d'achat";
  buyBtn.style.display = 'block';
  buyBtn.style.visibility = 'visible';
  buyBtn.style.opacity = '1';
  console.log('✅ Demande d\'achat button SHOWN');

  if (priceDisplay) {
    priceDisplay.textContent = property.Price1 || '—';
  }

  // ── Prevent duplicate listeners using a flag ──────────────────
  if (buyBtn._purchaseListenerAttached) {
    console.log('ℹ️ Purchase listener already attached, skipping');
    return;
  }
  buyBtn._purchaseListenerAttached = true;

  // ── Button click: auth check then open modal ──────────────────
  buyBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('🖱️ Demande d\'achat button CLICKED');

    const authStatus = await fetch('/api/auth-status').then(r => r.json());
    console.log('🔐 Auth status:', authStatus);

    if (!authStatus.loggedIn) {
      console.log('🔒 Not logged in → redirecting to login');
      window.location.href = `login.html?redirect=${encodeURIComponent('detail.html?id=' + property.ID)}`;
      return;
    }

    // Reset and open modal
    if (msgDiv) { msgDiv.className = ''; msgDiv.style.display = 'none'; }
    form.reset();
    modal.style.display = 'flex';
    console.log('🎉 Purchase modal OPENED');
  });

  // ── Close button ──────────────────────────────────────────────
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      modal.style.display = 'none';
      console.log('🔒 Purchase modal CLOSED');
    });
  }

  // ── ESC key ───────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      modal.style.display = 'none';
    }
  });

  // ── Form submit ───────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log('📤 Purchase form SUBMITTED');

    const contactPref = document.getElementById('purchaseContactPref')?.value || 'Email';
    const message = document.getElementById('purchaseMessage_text')?.value.trim() || '';

    // Re-verify auth before submitting
    const authStatus = await fetch('/api/auth-status').then(r => r.json());
    if (!authStatus.loggedIn) {
      showPurchaseMsg(msgDiv, 'error', "⚠️ Vous devez être connecté pour soumettre une demande d'achat");
      setTimeout(() => { window.location.href = 'login.html'; }, 1500);
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.style.opacity = '0.7';
    submitBtn.textContent = 'Envoi en cours...';

    const payload = {
      property_id: property.ID,
      preference_de_contact: contactPref,
      message
    };
    console.log('📦 API payload:', payload);

    try {
      const response = await fetch('/api/purchases/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      console.log('📊 API response status:', response.status);
      const data = await response.json();
      console.log('📊 API response data:', data);

      if (response.ok && data.success) {
        showPurchaseMsg(msgDiv, 'success', '✓ Demande envoyée ! Le vendeur vous contactera prochainement.');
        setTimeout(() => {
          modal.style.display = 'none';
          window.location.href = 'user_dashboard.html';
        }, 2500);
      } else {
        showPurchaseMsg(msgDiv, 'error', `⚠️ ${data.error || "Erreur lors de l'envoi de la demande"}`);
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.textContent = "Envoyer la demande d'achat";
      }
    } catch (error) {
      console.error('❌ Network error during purchase submit:', error);
      showPurchaseMsg(msgDiv, 'error', `⚠️ Erreur réseau : ${error.message}`);
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
      submitBtn.textContent = "Envoyer la demande d'achat";
    }
  });
}

// Helper to display a message inside the purchase modal
function showPurchaseMsg(msgDiv, type, text) {
  if (!msgDiv) return;
  msgDiv.className = type === 'success' ? 'success-alert' : 'error-alert';
  msgDiv.innerHTML = text;
  msgDiv.style.display = 'block';
}

// Charger les détails au chargement de la page
// Charger les détails de la propriété et mettre à jour le navbar au chargement
document.addEventListener("DOMContentLoaded", async () => {
  loadPropertyDetails();
  updateNavbarAuth(); // ✅ Afficher le status d'authentification et logout button
});
