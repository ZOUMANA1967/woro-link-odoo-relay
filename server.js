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
          fields: ["name", "list_price", "default_code", "categ_id", "qty_available", "public_categ_ids", "description_sale"],
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
          // Description commerciale, telle qu'ecrite dans Odoo (onglet Ventes).
          description: p.description_sale || null,
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

// Permet de forcer une copie immediate sans attendre le prochain cycle
// (utile juste apres avoir modifie des prix dans Odoo, par exemple).
app.post("/api/sync-now", async (req, res) => {
  await syncFromOdoo();
  res.json({ ok: cache.lastSyncOk, productCount: cache.products.length, lastSyncAt: cache.lastSyncAt });
});

// ---------------------------------------------------------------------------
// Demarrage : une premiere copie tout de suite, puis une copie reguliere
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Relais WORO-LINK <-> Odoo demarre sur le port ${PORT}`);
  syncFromOdoo();
  setInterval(syncFromOdoo, SYNC_INTERVAL_MINUTES * 60 * 1000);
});
