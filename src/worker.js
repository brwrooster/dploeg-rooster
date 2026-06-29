// Cloudflare Worker — D-Ploeg Rooster API
// Bindings nodig (zie wrangler.toml): DB (D1 database)

const FUNCTIE_ORDER = ["B", "M", "CTS", "CL", "OL"];
const FUNCTIE_SLOTS = { B: 1, M: 2, CTS: 1, CL: 1, OL: 1 };
const SESSION_DAYS = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
  });
}

function uid() {
  return crypto.randomUUID();
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getAdminFromToken(db, token) {
  if (!token) return null;
  const row = await db
    .prepare("SELECT s.admin_id, s.expires_at FROM sessions s WHERE s.token = ?")
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row.admin_id;
}

function requireAuth(handler) {
  return async (req, env, ctx) => {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const adminId = await getAdminFromToken(env.DB, token);
    if (!adminId) return json({ error: "Niet ingelogd of sessie verlopen." }, 401);
    ctx.adminId = adminId;
    return handler(req, env, ctx);
  };
}

// ---------- Assignment engine (server-side, mirrors the React prototype logic) ----------

async function buildCounts(db) {
  const personen = await db.prepare("SELECT id FROM personen").all();
  const counts = {};
  personen.results.forEach((p) => {
    counts[p.id] = { total: 0 };
    FUNCTIE_ORDER.forEach((f) => (counts[p.id][f] = 0));
  });
  // Handmatige correcties tellen niet mee — alleen automatisch ingedeelde
  // toewijzingen bepalen de eerlijke-verdelingsteller.
  const rows = await db.prepare("SELECT persoon_id, functie_code FROM toewijzingen WHERE handmatig = 0").all();
  rows.results.forEach((r) => {
    if (!counts[r.persoon_id]) return;
    counts[r.persoon_id][r.functie_code] = (counts[r.persoon_id][r.functie_code] || 0) + 1;
    counts[r.persoon_id].total += 1;
  });
  return counts;
}

async function getPersonenMetFuncties(db) {
  const personen = await db.prepare("SELECT id, naam FROM personen ORDER BY volgorde, naam").all();
  const functieRows = await db.prepare("SELECT persoon_id, functie_code, prioriteit FROM persoon_functies").all();
  const byPersoon = {};
  functieRows.results.forEach((r) => {
    if (!byPersoon[r.persoon_id]) byPersoon[r.persoon_id] = [];
    byPersoon[r.persoon_id].push({ code: r.functie_code, prioriteit: r.prioriteit });
  });
  return personen.results.map((p) => ({
    id: p.id,
    naam: p.naam,
    functies: byPersoon[p.id] || [],
  }));
}

function prioriteitVoor(persoon, code) {
  const f = persoon.functies.find((x) => x.code === code);
  return f ? f.prioriteit : null;
}

function magFunctie(persoon, code) {
  return persoon.functies.some((f) => f.code === code);
}

// Schaarste-eerst toewijzing met vast/reserve-voorrang binnen elke functie.
function assignDienst(beschikbarePersonen, counts) {
  const toewijzing = {}; // functieCode -> [personId]
  FUNCTIE_ORDER.forEach((f) => (toewijzing[f] = []));
  const reedsIngedeeld = new Set();
  const tekorten = [];

  let remainingSlots = [];
  FUNCTIE_ORDER.forEach((code) => {
    for (let i = 0; i < FUNCTIE_SLOTS[code]; i++) remainingSlots.push(code);
  });

  while (remainingSlots.length > 0) {
    const distinctCodes = [...new Set(remainingSlots)];
    let beste = null;

    distinctCodes.forEach((functieCode) => {
      const alleKandidaten = beschikbarePersonen.filter(
        (p) => !reedsIngedeeld.has(p.id) && magFunctie(p, functieCode)
      );
      const vasteKandidaten = alleKandidaten.filter((p) => prioriteitVoor(p, functieCode) === "vast");
      const kandidaten = vasteKandidaten.length > 0 ? vasteKandidaten : alleKandidaten;

      if (
        beste === null ||
        kandidaten.length < beste.kandidaten.length ||
        (kandidaten.length === beste.kandidaten.length && functieCode < beste.code)
      ) {
        beste = { code: functieCode, kandidaten };
      }
    });

    const { code: functieCode, kandidaten } = beste;
    const slotIdx = remainingSlots.indexOf(functieCode);
    remainingSlots.splice(slotIdx, 1);

    if (kandidaten.length === 0) {
      tekorten.push(functieCode);
      continue;
    }

    kandidaten.sort((a, b) => {
      const fa = counts[a.id]?.[functieCode] ?? 0;
      const fb = counts[b.id]?.[functieCode] ?? 0;
      if (fa !== fb) return fa - fb;
      const ta = counts[a.id]?.total ?? 0;
      const tb = counts[b.id]?.total ?? 0;
      if (ta !== tb) return ta - tb;
      return a.naam.localeCompare(b.naam);
    });

    const gekozen = kandidaten[0];
    toewijzing[functieCode].push(gekozen.id);
    reedsIngedeeld.add(gekozen.id);
    counts[gekozen.id][functieCode] = (counts[gekozen.id][functieCode] ?? 0) + 1;
    counts[gekozen.id].total = (counts[gekozen.id].total ?? 0) + 1;
  }

  return { toewijzing, tekorten: [...new Set(tekorten)] };
}

// ---------- Route handlers ----------

async function handleLogin(req, env) {
  const { gebruikersnaam, wachtwoord } = await req.json();
  if (!gebruikersnaam || !wachtwoord) return json({ error: "Gebruikersnaam en wachtwoord verplicht." }, 400);

  const admin = await env.DB.prepare("SELECT id, wachtwoord_hash FROM admins WHERE gebruikersnaam = ?")
    .bind(gebruikersnaam)
    .first();
  if (!admin) return json({ error: "Onjuiste gebruikersnaam of wachtwoord." }, 401);

  const hash = await sha256(wachtwoord);
  if (hash !== admin.wachtwoord_hash) return json({ error: "Onjuiste gebruikersnaam of wachtwoord." }, 401);

  const token = uid();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, admin.id, expires)
    .run();

  return json({ token, expires });
}

async function handleGetPersonen(req, env) {
  const personen = await getPersonenMetFuncties(env.DB);
  return json({ personen });
}

async function handleAddPersoon(req, env) {
  const { naam } = await req.json();
  if (!naam || !naam.trim()) return json({ error: "Naam is verplicht." }, 400);

  const aantal = await env.DB.prepare("SELECT COUNT(*) as n FROM personen").first();
  if (aantal.n >= 10) return json({ error: "Maximaal 10 namen toegestaan." }, 400);

  const id = uid();
  await env.DB.prepare("INSERT INTO personen (id, naam, volgorde) VALUES (?, ?, ?)")
    .bind(id, naam.trim(), aantal.n)
    .run();
  return json({ id, naam: naam.trim() });
}

async function handleDeletePersoon(req, env, ctx) {
  const id = ctx.params.id;
  await env.DB.prepare("DELETE FROM personen WHERE id = ?").bind(id).run();
  return json({ deleted: id });
}

async function handleSetFunctie(req, env, ctx) {
  const personId = ctx.params.id;
  const { functie_code, actief, prioriteit } = await req.json();
  if (!FUNCTIE_ORDER.includes(functie_code)) return json({ error: "Onbekende functie." }, 400);

  if (actief === false) {
    await env.DB.prepare("DELETE FROM persoon_functies WHERE persoon_id = ? AND functie_code = ?")
      .bind(personId, functie_code)
      .run();
    return json({ ok: true });
  }

  const prio = prioriteit === "reserve" ? "reserve" : "vast";
  await env.DB.prepare(
    `INSERT INTO persoon_functies (persoon_id, functie_code, prioriteit) VALUES (?, ?, ?)
     ON CONFLICT(persoon_id, functie_code) DO UPDATE SET prioriteit = excluded.prioriteit`
  )
    .bind(personId, functie_code, prio)
    .run();
  return json({ ok: true });
}

async function handleGetDiensten(req, env) {
  const diensten = await env.DB.prepare("SELECT id, datum FROM diensten ORDER BY datum").all();
  const result = [];
  for (const d of diensten.results) {
    const beschikbaar = await env.DB.prepare("SELECT persoon_id FROM beschikbaarheid WHERE dienst_id = ?")
      .bind(d.id)
      .all();
    const toewijzing = await env.DB.prepare(
      "SELECT persoon_id, functie_code, handmatig FROM toewijzingen WHERE dienst_id = ?"
    )
      .bind(d.id)
      .all();
    const tekorten = await env.DB.prepare("SELECT functie_code FROM tekorten WHERE dienst_id = ?")
      .bind(d.id)
      .all();

    const toewijzingMap = {};
    FUNCTIE_ORDER.forEach((f) => (toewijzingMap[f] = []));
    const handmatigPersonen = [];
    toewijzing.results.forEach((r) => {
      toewijzingMap[r.functie_code]?.push(r.persoon_id);
      if (r.handmatig) handmatigPersonen.push(r.persoon_id);
    });

    result.push({
      id: d.id,
      datum: d.datum,
      beschikbaar: beschikbaar.results.map((r) => r.persoon_id),
      toewijzing: toewijzing.results.length > 0 ? toewijzingMap : null,
      handmatigPersonen,
      tekorten: tekorten.results.map((r) => r.functie_code),
    });
  }
  return json({ diensten: result });
}

async function handleAddDienst(req, env) {
  const { datum } = await req.json();
  if (!datum) return json({ error: "Datum is verplicht." }, 400);

  const bestaat = await env.DB.prepare("SELECT id FROM diensten WHERE datum = ?").bind(datum).first();
  if (bestaat) return json({ error: "Er bestaat al een dienst op deze datum." }, 400);

  const id = uid();
  await env.DB.prepare("INSERT INTO diensten (id, datum) VALUES (?, ?)").bind(id, datum).run();

  // Standaard: iedereen beschikbaar
  const personen = await env.DB.prepare("SELECT id FROM personen").all();
  for (const p of personen.results) {
    await env.DB.prepare("INSERT INTO beschikbaarheid (dienst_id, persoon_id) VALUES (?, ?)").bind(id, p.id).run();
  }

  return json({ id, datum });
}

async function handleAddPeriode(req, env) {
  const { van, tot, interval } = await req.json();
  if (!van || !tot || !interval || interval < 1) return json({ error: "Van, tot en interval zijn verplicht." }, 400);

  const personen = await env.DB.prepare("SELECT id FROM personen").all();
  const bestaande = await env.DB.prepare("SELECT datum FROM diensten").all();
  const bestaandeSet = new Set(bestaande.results.map((r) => r.datum));

  const start = new Date(van + "T00:00:00Z");
  const einde = new Date(tot + "T00:00:00Z");
  const nieuwe = [];
  let cursor = new Date(start);
  while (cursor <= einde) {
    const iso = cursor.toISOString().slice(0, 10);
    if (!bestaandeSet.has(iso)) nieuwe.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + Number(interval));
  }

  for (const datum of nieuwe) {
    const id = uid();
    await env.DB.prepare("INSERT INTO diensten (id, datum) VALUES (?, ?)").bind(id, datum).run();
    for (const p of personen.results) {
      await env.DB.prepare("INSERT INTO beschikbaarheid (dienst_id, persoon_id) VALUES (?, ?)").bind(id, p.id).run();
    }
  }

  return json({ aangemaakt: nieuwe.length });
}

async function handleDeleteDienst(req, env, ctx) {
  const id = ctx.params.id;
  await env.DB.prepare("DELETE FROM diensten WHERE id = ?").bind(id).run();
  return json({ deleted: id });
}

async function handleSetBeschikbaar(req, env, ctx) {
  const dienstId = ctx.params.id;
  const { persoon_id, beschikbaar } = await req.json();

  if (beschikbaar) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO beschikbaarheid (dienst_id, persoon_id) VALUES (?, ?)"
    )
      .bind(dienstId, persoon_id)
      .run();
  } else {
    await env.DB.prepare("DELETE FROM beschikbaarheid WHERE dienst_id = ? AND persoon_id = ?")
      .bind(dienstId, persoon_id)
      .run();
  }
  return json({ ok: true });
}

async function handleSetAlleBeschikbaar(req, env, ctx) {
  const dienstId = ctx.params.id;
  const { aan } = await req.json();

  await env.DB.prepare("DELETE FROM beschikbaarheid WHERE dienst_id = ?").bind(dienstId).run();
  if (aan) {
    const personen = await env.DB.prepare("SELECT id FROM personen").all();
    for (const p of personen.results) {
      await env.DB.prepare("INSERT INTO beschikbaarheid (dienst_id, persoon_id) VALUES (?, ?)")
        .bind(dienstId, p.id)
        .run();
    }
  }
  return json({ ok: true });
}

async function handleIndelenEen(req, env, ctx) {
  const dienstId = ctx.params.id;
  const allePersonen = await getPersonenMetFuncties(env.DB);
  const beschikbaarRows = await env.DB.prepare("SELECT persoon_id FROM beschikbaarheid WHERE dienst_id = ?")
    .bind(dienstId)
    .all();
  const beschikbaarIds = new Set(beschikbaarRows.results.map((r) => r.persoon_id));
  const beschikbarePersonen = allePersonen.filter((p) => beschikbaarIds.has(p.id));

  const counts = await buildCounts(env.DB);
  const { toewijzing, tekorten } = assignDienst(beschikbarePersonen, counts);

  await env.DB.prepare("DELETE FROM toewijzingen WHERE dienst_id = ?").bind(dienstId).run();
  await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ?").bind(dienstId).run();

  for (const code of FUNCTIE_ORDER) {
    for (const personId of toewijzing[code]) {
      await env.DB.prepare(
        "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code) VALUES (?, ?, ?)"
      )
        .bind(dienstId, personId, code)
        .run();
    }
  }
  for (const code of tekorten) {
    await env.DB.prepare("INSERT INTO tekorten (dienst_id, functie_code) VALUES (?, ?)")
      .bind(dienstId, code)
      .run();
  }

  return json({ toewijzing, tekorten });
}

// Handmatige correctie: vervang op één functie-plek de toegewezen persoon door een
// andere, voor deze specifieke dienst. Telt niet mee voor de eerlijke verdeling
// (zie buildCounts, die WHERE handmatig = 0 gebruikt). Alleen toegestaan als de
// nieuwe persoon beschikbaar is voor deze dienst én de functie mag.
async function handleWijzigToewijzing(req, env, ctx) {
  const dienstId = ctx.params.id;
  const { functie_code, oude_persoon_id, nieuwe_persoon_id } = await req.json();

  if (!FUNCTIE_ORDER.includes(functie_code)) return json({ error: "Onbekende functie." }, 400);
  if (!nieuwe_persoon_id) return json({ error: "Nieuwe persoon is verplicht." }, 400);

  const beschikbaar = await env.DB.prepare(
    "SELECT 1 FROM beschikbaarheid WHERE dienst_id = ? AND persoon_id = ?"
  )
    .bind(dienstId, nieuwe_persoon_id)
    .first();
  if (!beschikbaar) return json({ error: "Deze persoon is niet beschikbaar voor deze dienst." }, 400);

  const magFunctie = await env.DB.prepare(
    "SELECT 1 FROM persoon_functies WHERE persoon_id = ? AND functie_code = ?"
  )
    .bind(nieuwe_persoon_id, functie_code)
    .first();
  if (!magFunctie) return json({ error: "Deze persoon mag deze functie niet vervullen." }, 400);

  // Staat de nieuwe persoon al ergens anders ingedeeld binnen deze dienst? Dan wisselen
  // we de twee plekken om, in plaats van te weigeren — mits beide ook de andere
  // functie mogen vervullen.
  const bestaandeRij = await env.DB.prepare(
    "SELECT functie_code FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ?"
  )
    .bind(dienstId, nieuwe_persoon_id)
    .first();

  if (bestaandeRij) {
    const huidigeFunctieVanNieuwePersoon = bestaandeRij.functie_code;
    if (huidigeFunctieVanNieuwePersoon === functie_code) {
      return json({ error: "Deze persoon staat hier al ingedeeld." }, 400);
    }
    if (!oude_persoon_id) {
      return json({ error: "Kan niet wisselen: er staat hier niemand om mee te ruilen." }, 400);
    }

    // De oude persoon moet de functie van de nieuwe persoon ook mogen, anders is de wissel niet geldig.
    const oudeMagNieuweFunctie = await env.DB.prepare(
      "SELECT 1 FROM persoon_functies WHERE persoon_id = ? AND functie_code = ?"
    )
      .bind(oude_persoon_id, huidigeFunctieVanNieuwePersoon)
      .first();
    if (!oudeMagNieuweFunctie) {
      return json({ error: "De huidige persoon op deze plek mag de andere functie niet vervullen — wisselen niet mogelijk." }, 400);
    }

    await env.DB.prepare("DELETE FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ?")
      .bind(dienstId, oude_persoon_id)
      .run();
    await env.DB.prepare("DELETE FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ?")
      .bind(dienstId, nieuwe_persoon_id)
      .run();
    await env.DB.prepare(
      "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, handmatig) VALUES (?, ?, ?, 1)"
    )
      .bind(dienstId, nieuwe_persoon_id, functie_code)
      .run();
    await env.DB.prepare(
      "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, handmatig) VALUES (?, ?, ?, 1)"
    )
      .bind(dienstId, oude_persoon_id, huidigeFunctieVanNieuwePersoon)
      .run();

    await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND functie_code = ?")
      .bind(dienstId, functie_code)
      .run();
    await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND functie_code = ?")
      .bind(dienstId, huidigeFunctieVanNieuwePersoon)
      .run();

    return json({ ok: true, gewisseld: true });
  }

  if (oude_persoon_id) {
    await env.DB.prepare(
      "DELETE FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ? AND functie_code = ?"
    )
      .bind(dienstId, oude_persoon_id, functie_code)
      .run();
  }

  await env.DB.prepare(
    "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, handmatig) VALUES (?, ?, ?, 1)"
  )
    .bind(dienstId, nieuwe_persoon_id, functie_code)
    .run();

  // Als deze plek eerder een tekort was, is dat nu opgelost.
  await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND functie_code = ?")
    .bind(dienstId, functie_code)
    .run();

  return json({ ok: true });
}

async function handleIndelenAlles(req, env) {
  const alleDiensten = await env.DB.prepare("SELECT id FROM diensten ORDER BY datum").all();
  const allePersonen = await getPersonenMetFuncties(env.DB);

  // Reset alle bestaande toewijzingen, dan opnieuw opbouwen in datumvolgorde
  // zodat de eerlijke verdeling chronologisch klopt.
  await env.DB.prepare("DELETE FROM toewijzingen").run();
  await env.DB.prepare("DELETE FROM tekorten").run();

  const counts = {};
  allePersonen.forEach((p) => {
    counts[p.id] = { total: 0 };
    FUNCTIE_ORDER.forEach((f) => (counts[p.id][f] = 0));
  });

  for (const d of alleDiensten.results) {
    const beschikbaarRows = await env.DB.prepare(
      "SELECT persoon_id FROM beschikbaarheid WHERE dienst_id = ?"
    )
      .bind(d.id)
      .all();
    const beschikbaarIds = new Set(beschikbaarRows.results.map((r) => r.persoon_id));
    const beschikbarePersonen = allePersonen.filter((p) => beschikbaarIds.has(p.id));

    const { toewijzing, tekorten } = assignDienst(beschikbarePersonen, counts);

    for (const code of FUNCTIE_ORDER) {
      for (const personId of toewijzing[code]) {
        await env.DB.prepare(
          "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code) VALUES (?, ?, ?)"
        )
          .bind(d.id, personId, code)
          .run();
      }
    }
    for (const code of tekorten) {
      await env.DB.prepare("INSERT INTO tekorten (dienst_id, functie_code) VALUES (?, ?)")
        .bind(d.id, code)
        .run();
    }
  }

  return json({ ok: true, aantal: alleDiensten.results.length });
}

// Publieke, read-only endpoint voor gasten — geen login nodig
async function handlePubliekRooster(req, env) {
  const personen = await getPersonenMetFuncties(env.DB);
  const dienstenResp = await handleGetDiensten(req, env);
  const dienstenData = await dienstenResp.json();
  return json({ personen, diensten: dienstenData.diensten });
}

// ---------- Router ----------

const routes = [
  { method: "POST", pattern: /^\/api\/login$/, handler: handleLogin },
  { method: "GET", pattern: /^\/api\/rooster$/, handler: handlePubliekRooster },

  { method: "GET", pattern: /^\/api\/personen$/, handler: requireAuth(handleGetPersonen) },
  { method: "POST", pattern: /^\/api\/personen$/, handler: requireAuth(handleAddPersoon) },
  { method: "DELETE", pattern: /^\/api\/personen\/([^/]+)$/, handler: requireAuth(handleDeletePersoon), params: ["id"] },
  { method: "POST", pattern: /^\/api\/personen\/([^/]+)\/functie$/, handler: requireAuth(handleSetFunctie), params: ["id"] },

  { method: "GET", pattern: /^\/api\/diensten$/, handler: requireAuth(handleGetDiensten) },
  { method: "POST", pattern: /^\/api\/diensten$/, handler: requireAuth(handleAddDienst) },
  { method: "POST", pattern: /^\/api\/diensten\/periode$/, handler: requireAuth(handleAddPeriode) },
  { method: "DELETE", pattern: /^\/api\/diensten\/([^/]+)$/, handler: requireAuth(handleDeleteDienst), params: ["id"] },
  { method: "POST", pattern: /^\/api\/diensten\/([^/]+)\/beschikbaar$/, handler: requireAuth(handleSetBeschikbaar), params: ["id"] },
  { method: "POST", pattern: /^\/api\/diensten\/([^/]+)\/beschikbaar-alle$/, handler: requireAuth(handleSetAlleBeschikbaar), params: ["id"] },
  { method: "POST", pattern: /^\/api\/diensten\/([^/]+)\/indelen$/, handler: requireAuth(handleIndelenEen), params: ["id"] },
  { method: "POST", pattern: /^\/api\/diensten\/([^/]+)\/wijzig-toewijzing$/, handler: requireAuth(handleWijzigToewijzing), params: ["id"] },
  { method: "POST", pattern: /^\/api\/diensten\/indelen-alles$/, handler: requireAuth(handleIndelenAlles) },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({});
    }

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;

      const ctx = {};
      if (route.params) {
        ctx.params = {};
        route.params.forEach((name, idx) => (ctx.params[name] = match[idx + 1]));
      }

      try {
        return await route.handler(request, env, ctx);
      } catch (err) {
        return json({ error: "Serverfout: " + err.message }, 500);
      }
    }

    return json({ error: "Niet gevonden." }, 404);
  },
};
