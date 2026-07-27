// ---------------------------------------------------------------------------
// Serveur relais WORO-LINK <-> Odoo (avec copie automatique / cache)
//
// Difference avec la version precedente : au lieu d'aller demander a Odoo
// a CHAQUE fois qu'un client ouvre l'app, ce relais fait une copie des
// produits a intervalles reguliers (ex: toutes les heures) et la garde en
// memoire. L'app consulte toujours cette copie -- rapide, et Odoo n'est
// sollicite qu'une fois de temps en temps, pas a chaque visite client.
//
// Reglages dans le fichier .env (voir .env.example) :
//   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY  -> acces a Odoo
//   SYNC_INTERVAL_MINUTES                            -> frequence de copie
// ---------------------------------------------------------------------------

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_API_KEY;
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 60;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const APP_KEY = process.env.APP_KEY || null;

// Verifie que l'appel vient bien de votre app (cle partagee simple, envoyee
// dans l'en-tete X-App-Key). Protection legere -- elle empeche les visites
// aleatoires de robots de polluer vos statistiques/commandes, mais comme
// cette cle vit dans le code de l'app affiche dans le navigateur, une
// personne technique determinee pourrait la retrouver. Pour une vraie
// securite de paiement, il faudra un jour un systeme de comptes complet.
function requireAppKey(req, res, next) {
  if (!APP_KEY) return next(); // si pas configuree, on n'exige rien (retro-compatible)
  if (req.headers["x-app-key"] !== APP_KEY) {
    return res.status(401).json({ error: "Cle d'application manquante ou incorrecte." });
  }
  next();
}

// ---------------------------------------------------------------------------
// Donnees du panneau d'administration -- gardees simplement en memoire,
// comme le catalogue. Elles repartent a zero si le relais redemarre
// (offre gratuite Render) ; suffisant pour une premiere version.
// ---------------------------------------------------------------------------
let orders = [];
let visitsBySite = {}; // { "z-reseaux": 12, "teeshopafrica": 4, ... }
let nextOrderId = 1;

// Verifie la cle d'administration (parametre ?key=... dans l'adresse).
// Protection simple, pas un vrai systeme de comptes -- suffisant pour un
// usage interne, mais a ne pas partager publiquement.
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: "ADMIN_KEY n'est pas configuree sur le relais." });
  }
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Cle d'administration manquante ou incorrecte." });
  }
  next();
}

// ---------------------------------------------------------------------------
// La "copie" -- gardee simplement en memoire, pas de base de donnees a gerer
// ---------------------------------------------------------------------------
let cache = {
  products: [],
  lastSyncAt: null,
  lastSyncOk: false,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Communication avec Odoo (JSON-RPC)
// ---------------------------------------------------------------------------
// Nettoie le HTML d'Odoo (balises, entites) pour n'en garder que le texte,
// afin de l'afficher simplement dans l'app.
function stripHtml(html) {
  if (!html) return null;
  const text = html
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

async function odooCall(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1000000),
    }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.data?.message || "Erreur Odoo");
  }
  return json.result;
}

async function odooAuthenticate() {
  const uid = await odooCall("common", "authenticate", [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}]);
  if (!uid) throw new Error("Connexion a Odoo refusee -- verifiez ODOO_DB / ODOO_USERNAME / ODOO_API_KEY");
  return uid;
}

// ---------------------------------------------------------------------------
// La synchronisation : va chercher tous les produits vendables dans Odoo
// et remplace le contenu de la copie en memoire.
//
// IMPORTANT : Odoo a DEUX systemes de categories differents :
//   - categ_id          -> categorie "interne" (comptabilite/gestion)
//   - public_categ_ids  -> categorie(s) "boutique en ligne", celles qui
//                          contiennent les sous-categories vues sur le site
// On utilise desormais public_categ_ids pour que l'app retrouve les memes
// sous-categories que sur www.z-reseaux.com.
// ---------------------------------------------------------------------------
async function syncFromOdoo() {
  console.log(`[sync] Debut de la copie depuis Odoo -- ${new Date().toISOString()}`);
  try {
    const uid = await odooAuthenticate();

    // 1) Recupere TOUTES les categories "boutique en ligne", pour pouvoir
    // reconstruire le chemin complet (Parent / Enfant) de chacune.
    const publicCategories = await odooCall("object", "execute_kw", [
      ODOO_DB, uid, ODOO_API_KEY,
      "product.public.category", "search_read",
      [[]],
      { fields: ["name", "parent_id"] },
    ]);
    const categoryById = {};
    for (const cat of publicCategories) categoryById[cat.id] = cat;

    function fullPathFor(catId) {
      const parts = [];
      let current = categoryById[catId];
      let guard = 0;
      while (current && guard < 10) {
        parts.unshift(current.name);
        current = current.parent_id ? categoryById[current.parent_id[0]] : null;
        guard++;
      }
      return parts.join(" / ");
    }

    // 2) Recupere les produits, avec leur(s) categorie(s) boutique en ligne
    const allProducts = [];
    const pageSize = 500;
    let offset = 0;

    while (true) {
      const page = await odooCall("object", "execute_kw", [
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "product.template",
        "search_read",
        [[["sale_ok", "=", true]]],
        {
          fields: ["name", "list_price", "default_code", "categ_id", "qty_available", "public_categ_ids", "website_description"],
          limit: pageSize,
          offset,
          order: "id asc",
        },
      ]);
      allProducts.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    cache = {
      products: allProducts.map((p) => {
        // Categorie boutique en ligne (avec sous-categorie) si elle existe,
        // sinon on retombe sur la categorie interne pour ne rien perdre.
        let category = null;
        if (p.public_categ_ids && p.public_categ_ids.length > 0) {
          category = fullPathFor(p.public_categ_ids[0]);
        } else if (p.categ_id) {
          category = p.categ_id[1];
        }
        return {
          id: String(p.id),
          ref: p.default_code || null,
          name: p.name,
          price: Math.round(p.list_price),
          category,
          stock: p.qty_available,
          // Image du produit -- Odoo expose ses images via cette adresse
          // publique, pas besoin de les televerser ailleurs.
          image: `${ODOO_URL}/web/image/product.template/${p.id}/image_512`,
          // Description commerciale -- vient du champ "website_description"
          // d'Odoo (celui utilise par la boutique en ligne), qui contient du
          // HTML : on le nettoie pour n'en garder que le texte lisible.
          description: stripHtml(p.website_description),
        };
      }),
      lastSyncAt: new Date().toISOString(),
      lastSyncOk: true,
      lastError: null,
    };

    console.log(`[sync] Termine -- ${cache.products.length} produits copies`);
  } catch (err) {
    console.error("[sync] Echec de la copie:", err.message);
    cache.lastSyncOk = false;
    cache.lastError = err.message;
    // On garde volontairement les anciens produits en memoire plutot que de
    // vider la copie -- l'app continue de fonctionner avec les dernieres
    // donnees connues meme si Odoo est momentanement injoignable.
  }
}

// ---------------------------------------------------------------------------
// Routes exposees a l'application
// ---------------------------------------------------------------------------

// Liste des produits -- servie depuis la copie en memoire, jamais depuis Odoo
// directement. Reponse quasi instantanee, meme si Odoo est lent ou indisponible.
app.get("/api/products", (req, res) => {
  let results = cache.products;

  if (req.query.category) {
    const needle = req.query.category.toLowerCase();
    results = results.filter((p) => p.category && p.category.toLowerCase().includes(needle));
  }

  const limit = parseInt(req.query.limit) || results.length;
  const offset = parseInt(req.query.offset) || 0;

  res.json({
    products: results.slice(offset, offset + limit),
    total: results.length,
    lastSyncAt: cache.lastSyncAt,
  });
});

// Etat du relais et de la derniere copie -- pratique pour verifier que tout va bien
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(ODOO_URL && ODOO_DB && ODOO_USERNAME && ODOO_API_KEY),
    lastSyncAt: cache.lastSyncAt,
    lastSyncOk: cache.lastSyncOk,
    lastError: cache.lastError,
    productCount: cache.products.length,
    syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
  });
});

// Enregistre une visite (l'app appelle cette route a l'ouverture).
// Sert juste a avoir une idee de frequentation par boutique, rien de plus.
app.post("/api/visits", requireAppKey, (req, res) => {
  const siteKey = req.body?.siteKey || "inconnu";
  visitsBySite[siteKey] = (visitsBySite[siteKey] || 0) + 1;
  res.json({ ok: true });
});

// Cherche un client existant par telephone, sinon en cree un nouveau.
// Carnet d'adresses du relais : garde le lien telephone -> contact Odoo,
// mais UNIQUEMENT pour les contacts que le relais a lui-meme crees depuis
// l'app. On ne va jamais chercher/modifier un contact deja existant dans
// Odoo (fournisseur, autre client, fiche de l'entreprise...) pour eviter
// d'ecraser des donnees qui n'ont rien a voir.
// Limite connue : si le relais redemarre (offre gratuite Render), ce carnet
// se vide et un client qui recommande une seconde fois aura un nouveau
// contact cree plutot que de retrouver le precedent -- compromis assume
// pour ne jamais toucher a des donnees existantes.
let partnerIdByPhone = {};

async function findOrCreatePartner(uid, name, phone, address, email) {
  if (phone && partnerIdByPhone[phone]) {
    // Deja cree par le relais lors d'une commande precedente : on met a
    // jour son nom/adresse/email sans risque, puisque c'est "notre" contact.
    const partnerId = partnerIdByPhone[phone];
    await odooCall("object", "execute_kw", [
      ODOO_DB, uid, ODOO_API_KEY, "res.partner", "write",
      [[partnerId], { name: name || "Client app WORO-LINK", street: address || false, email: email || false }],
    ]);
    return partnerId;
  }
  const newId = await odooCall("object", "execute_kw", [
    ODOO_DB, uid, ODOO_API_KEY, "res.partner", "create",
    [{ name: name || "Client app WORO-LINK", phone: phone || false, street: address || false, email: email || false }],
  ]);
  if (phone) partnerIdByPhone[phone] = newId;
  return newId;
}

// Cree une vraie commande dans Odoo (etat "Devis" / brouillon -- rien n'est
// confirme ni facture automatiquement, quelqu'un doit la valider dans Odoo).
async function createOdooSaleOrder(order) {
  const uid = await odooAuthenticate();
  const partnerId = await findOrCreatePartner(uid, order.customerName, order.customerPhone, order.deliveryAddress, order.customerEmail);
  const orderLines = order.items.map((it) => [
    0, 0,
    { product_id: parseInt(it.id), product_uom_qty: it.qty || 1, price_unit: it.price || 0 },
  ]);
  const saleOrderId = await odooCall("object", "execute_kw", [
    ODOO_DB, uid, ODOO_API_KEY, "sale.order", "create",
    [{
      partner_id: partnerId,
      // Force les blocs "Facturation" et "Livraison" a utiliser ce meme
      // contact (avec son adresse) -- sans ça, Odoo ne les remplit pas
      // automatiquement quand la commande est creee par ce chemin technique.
      partner_invoice_id: partnerId,
      partner_shipping_id: partnerId,
      order_line: orderLines,
      // Note visible dans Odoo, pour que l'adresse de livraison saisie dans
      // l'app soit toujours lisible meme si elle n'a pas ete structuree.
      note: order.deliveryAddress ? `Adresse de livraison (app) : ${order.deliveryAddress}` : false,
    }],
  ]);
  return saleOrderId;
}

// Enregistre une commande passee dans l'app : la garde en memoire pour le
// panneau d'administration, ET tente de creer un vrai devis dans Odoo.
// Si Odoo est injoignable, la commande reste quand meme visible dans le
// panneau (avec une pastille d'erreur), pour ne rien perdre.
app.post("/api/orders", requireAppKey, async (req, res) => {
  const { siteKey, items, total, customerName, customerPhone, customerEmail, deliveryAddress } = req.body || {};
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Commande vide ou invalide." });
  }
  const order = {
    id: nextOrderId++,
    siteKey: siteKey || "inconnu",
    items,
    total: total || items.reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0),
    customerName: customerName || null,
    customerPhone: customerPhone || null,
    customerEmail: customerEmail || null,
    deliveryAddress: deliveryAddress || null,
    createdAt: new Date().toISOString(),
    odooOk: false,
    odooOrderId: null,
    odooError: null,
  };

  try {
    order.odooOrderId = await createOdooSaleOrder(order);
    order.odooOk = true;
  } catch (err) {
    order.odooError = err.message;
    console.error("[orders] Echec de creation du devis Odoo:", err.message);
  }

  orders.unshift(order);
  if (orders.length > 500) orders = orders.slice(0, 500); // garde-fou memoire
  res.json({ ok: true, orderId: order.id, odooOk: order.odooOk, odooOrderId: order.odooOrderId });
});

// Calcule l'etat de completude du catalogue : combien de produits ont une
// categorie/sous-categorie renseignee, par grande categorie. Sert a savoir
// ou concentrer le travail de classement dans Odoo.
function computeCatalogStats() {
  const perCategory = {};
  let withCategory = 0;
  let withSubcategory = 0;

  for (const p of cache.products) {
    const segments = (p.category || "").split("/").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    withCategory++;
    const top = segments[0];
    if (!perCategory[top]) perCategory[top] = { total: 0, withSubcategory: 0 };
    perCategory[top].total++;
    if (segments.length >= 2) {
      withSubcategory++;
      perCategory[top].withSubcategory++;
    }
  }

  const byCategory = Object.entries(perCategory)
    .map(([name, v]) => ({ name, total: v.total, withSubcategory: v.withSubcategory }))
    .sort((a, b) => b.total - a.total);

  return {
    totalProducts: cache.products.length,
    withCategory,
    withSubcategory,
    byCategory,
  };
}

// Tableau de bord (donnees) -- protege par cle d'administration.
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({
    sync: {
      lastSyncAt: cache.lastSyncAt,
      lastSyncOk: cache.lastSyncOk,
      lastError: cache.lastError,
      productCount: cache.products.length,
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
    },
    catalog: computeCatalogStats(),
    visitsBySite,
    orderCount: orders.length,
    odooOrderCount: orders.filter((o) => o.odooOk).length,
    revenueTotal: orders.reduce((s, o) => s + (o.total || 0), 0),
  });
});

// Liste des commandes -- protegee par cle d'administration.
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ orders: orders.slice(0, limit), total: orders.length });
});

// Historique de commandes d'un client -- utilise par l'ecran "Mon compte"
// de l'app. Identification simple par numero de telephone (pas de mot de
// passe pour l'instant), protegee par la cle d'application comme le reste
// des appels venant de l'app.
app.get("/api/my-orders", requireAppKey, (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "Numero de telephone manquant." });
  const mine = orders
    .filter((o) => o.customerPhone === phone)
    .map((o) => ({
      id: o.id,
      items: o.items,
      total: o.total,
      createdAt: o.createdAt,
      odooOk: o.odooOk,
      deliveryAddress: o.deliveryAddress,
    }));
  res.json({ orders: mine });
});

// Petite page web du panneau d'administration -- pas de build, juste du
// HTML/JS simple servi directement par le relais.
app.get("/admin", (req, res) => {
  res.type("html").send(ADMIN_HTML);
});

// Outil de diagnostic : affiche TOUS les champs bruts d'un produit precis,
// pour trouver le bon nom de champ sans avoir a redeployer a chaque essai.
// Usage : /api/debug-product/3162?key=VOTRE_CLE
app.get("/api/debug-product/:id", requireAdmin, async (req, res) => {
  try {
    const uid = await odooAuthenticate();
    const result = await odooCall("object", "execute_kw", [
      ODOO_DB, uid, ODOO_API_KEY,
      "product.template", "read",
      [[parseInt(req.params.id)]],
      {},
    ]);
    res.json(result[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permet de forcer une copie immediate sans attendre le prochain cycle
// (utile juste apres avoir modifie des prix ou des descriptions dans Odoo).
// Version GET : pratique pour la declencher juste en ouvrant l'adresse
// dans un navigateur, sans outil technique.
app.get("/api/sync-now", async (req, res) => {
  await syncFromOdoo();
  res.json({ ok: cache.lastSyncOk, productCount: cache.products.length, lastSyncAt: cache.lastSyncAt });
});
app.post("/api/sync-now", async (req, res) => {
  await syncFromOdoo();
  res.json({ ok: cache.lastSyncOk, productCount: cache.products.length, lastSyncAt: cache.lastSyncAt });
});

// ---------------------------------------------------------------------------
// Demarrage : une premiere copie tout de suite, puis une copie reguliere
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Panneau d'administration -- page HTML autonome (pas de build necessaire).
// Demande la cle d'administration, puis affiche l'etat du catalogue, les
// visites et les commandes.
// ---------------------------------------------------------------------------
const ADMIN_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WORO-LINK — Administration</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'IBM Plex Sans', sans-serif; background: #F1EBDD; margin: 0; padding: 20px; color: #1B2A3D; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #1B2A3D99; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: white; border-radius: 12px; padding: 16px; border: 1px solid #1B2A3D14; }
  .card .label { font-size: 11px; color: #1B2A3D99; text-transform: uppercase; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .card .value.ok { color: #5C7A52; }
  .card .value.err { color: #C1592B; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; margin-bottom: 24px; }
  th, td { text-align: left; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #1B2A3D0F; }
  th { background: #1B2A3D; color: white; font-weight: 500; }
  .bar-bg { background: #1B2A3D14; border-radius: 6px; height: 8px; width: 100%; overflow: hidden; }
  .bar-fill { background: #5C7A52; height: 100%; }
  h2 { font-size: 14px; margin: 24px 0 10px; }
  #keyForm { max-width: 320px; margin: 60px auto; text-align: center; }
  input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #1B2A3D33; margin-bottom: 10px; }
  button { width: 100%; padding: 10px; border-radius: 8px; border: none; background: #1B2A3D; color: white; font-weight: 600; cursor: pointer; }
  .refresh { float: right; font-size: 12px; color: #1B2A3D99; cursor: pointer; text-decoration: underline; }
</style>
</head>
<body>

<div id="keyForm">
  <h1>WORO-LINK — Administration</h1>
  <p class="sub">Entrez la clé d'administration pour accéder au tableau de bord.</p>
  <input type="password" id="keyInput" placeholder="Clé d'administration" />
  <button onclick="loadDashboard()">Accéder</button>
  <p id="keyError" style="color:#C1592B; font-size:12px;"></p>
</div>

<div id="dashboard" style="display:none;">
  <h1>WORO-LINK — Administration <span class="refresh" onclick="loadDashboard()">↻ actualiser</span></h1>
  <p class="sub" id="syncLine"></p>

  <div class="grid" id="statCards"></div>

  <h2>Complétude du catalogue par catégorie</h2>
  <table id="catalogTable"><thead><tr><th>Catégorie</th><th>Produits</th><th>Avec sous-catégorie</th><th></th></tr></thead><tbody></tbody></table>

  <h2>Visites par boutique</h2>
  <table id="visitsTable"><thead><tr><th>Boutique</th><th>Visites</th></tr></thead><tbody></tbody></table>

  <h2>Dernières commandes</h2>
  <table id="ordersTable"><thead><tr><th>#</th><th>Boutique</th><th>Client</th><th>Email</th><th>Total</th><th>Odoo</th><th>Date</th></tr></thead><tbody></tbody></table>
</div>

<script>
function getKey() {
  return localStorage.getItem('woroAdminKey') || '';
}

async function loadDashboard() {
  const inputEl = document.getElementById('keyInput');
  const key = inputEl ? inputEl.value.trim() : getKey();
  if (!key) return;
  localStorage.setItem('woroAdminKey', key);

  try {
    const [statsRes, ordersRes] = await Promise.all([
      fetch('/api/admin/stats?key=' + encodeURIComponent(key)),
      fetch('/api/admin/orders?key=' + encodeURIComponent(key) + '&limit=20'),
    ]);
    if (statsRes.status === 401) {
      document.getElementById('keyError').textContent = 'Clé incorrecte.';
      return;
    }
    const stats = await statsRes.json();
    const ordersData = await ordersRes.json();

    document.getElementById('keyForm').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';

    document.getElementById('syncLine').textContent =
      'Dernière synchro : ' + (stats.sync.lastSyncAt ? new Date(stats.sync.lastSyncAt).toLocaleString('fr-FR') : 'jamais') +
      (stats.sync.lastSyncOk ? ' — OK' : ' — ÉCHEC : ' + stats.sync.lastError);

    document.getElementById('statCards').innerHTML = [
      card('Produits synchronisés', stats.sync.productCount, stats.sync.lastSyncOk ? 'ok' : 'err'),
      card('Avec sous-catégorie', stats.catalog.withSubcategory + ' / ' + stats.catalog.totalProducts),
      card('Commandes enregistrées', stats.orderCount),
      card('Devis créés dans Odoo', stats.odooOrderCount + ' / ' + stats.orderCount, stats.odooOrderCount === stats.orderCount ? 'ok' : 'err'),
      card('Chiffre cumulé (F CFA)', Number(stats.revenueTotal).toLocaleString('fr-FR')),
    ].join('');

    const catBody = document.querySelector('#catalogTable tbody');
    catBody.innerHTML = stats.catalog.byCategory.map(function(c) {
      const pct = c.total > 0 ? Math.round((c.withSubcategory / c.total) * 100) : 0;
      return '<tr><td>' + c.name + '</td><td>' + c.total + '</td><td>' + c.withSubcategory + ' (' + pct + '%)</td>' +
        '<td><div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%"></div></div></td></tr>';
    }).join('');

    const visitsBody = document.querySelector('#visitsTable tbody');
    const visitEntries = Object.entries(stats.visitsBySite || {});
    visitsBody.innerHTML = visitEntries.length
      ? visitEntries.map(function(e) { return '<tr><td>' + e[0] + '</td><td>' + e[1] + '</td></tr>'; }).join('')
      : '<tr><td colspan="2">Aucune visite enregistrée pour le moment.</td></tr>';

    const ordersBody = document.querySelector('#ordersTable tbody');
    ordersBody.innerHTML = ordersData.orders.length
      ? ordersData.orders.map(function(o) {
          const odooCell = o.odooOk
            ? '<span style="color:#5C7A52;">✓ Devis #' + o.odooOrderId + '</span>'
            : '<span style="color:#C1592B;" title="' + (o.odooError || '') + '">✗ échec</span>';
          return '<tr><td>#' + o.id + '</td><td>' + o.siteKey + '</td><td>' + (o.customerName || '—') + '</td>' +
            '<td>' + (o.customerEmail || '—') + '</td>' +
            '<td>' + Number(o.total).toLocaleString('fr-FR') + ' F</td><td>' + odooCell + '</td><td>' + new Date(o.createdAt).toLocaleString('fr-FR') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="7">Aucune commande enregistrée pour le moment.</td></tr>';
  } catch (err) {
    document.getElementById('keyError').textContent = 'Erreur : ' + err.message;
  }
}

function card(label, value, cls) {
  return '<div class="card"><div class="label">' + label + '</div><div class="value ' + (cls || '') + '">' + value + '</div></div>';
}

// Si une cle est deja enregistree, on charge directement
if (getKey()) { loadDashboard(); }
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`Relais WORO-LINK <-> Odoo demarre sur le port ${PORT}`);
  syncFromOdoo();
  setInterval(syncFromOdoo, SYNC_INTERVAL_MINUTES * 60 * 1000);
});
