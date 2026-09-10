// Deploy trigger - multi-team fix

// Cloudflare Worker — D-Ploeg Rooster API (MULTI-TEAM)
// Bindings nodig (zie wrangler.toml): DB (D1 database)

const FUNCTIE_ORDER = ["B", "M", "CTS", "CL", "OL", "CHV", "OHV"];
const FUNCTIE_SLOTS = { B: 1, M: 2, CTS: 1, CL: 1, OL: 1, CHV: 1, OHV: 1 };
const SESSION_DAYS = 30;

// Welke functies elk team daadwerkelijk gebruikt bij het indelen/tekorten-berekenen.
// Onbekende teams vallen terug op de Veluwsekant-set.
const TEAM_FUNCTIES = {
  veluwsekant: ["B", "M", "CTS", "CL", "OL"],
  aploeg: ["B", "M", "CTS", "CL", "OL"],
  bploeg: ["B", "M", "CTS", "CL", "OL"],
  cploeg: ["B", "M", "CTS", "CL", "OL"],
};

// Weergavenamen per team, voor gebruik in de publieke rooster-respons
// (zodat de frontend de juiste titel/branding kan tonen zonder dit hard te coderen).
const TEAM_NAMEN = {
  veluwsekant: "D-Ploeg Veluwsekant",
  aploeg: "A-Ploeg Veluwsekant",
  bploeg: "B-Ploeg Veluwsekant",
  cploeg: "C-Ploeg Veluwsekant",
};

function functiesVoorTeam(team) {
  return TEAM_FUNCTIES[team] || TEAM_FUNCTIES.veluwsekant;
}

function naamVoorTeam(team) {
  return TEAM_NAMEN[team] || team;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Team",
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

// --- AANGEPAST: sessie bevat nu het team, dus we hoeven het niet meer los te valideren ---
async function getSession(db, token) {
  if (!token) return null;
  const row = await db
    .prepare("SELECT s.admin_id, s.team_id, s.expires_at FROM sessions s WHERE s.token = ?")
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row; // { admin_id, team_id, expires_at }
}

// --- AANGEPAST: team komt nu uit de sessie (server-side), niet meer uit de X-Team header ---
function requireAuth(handler) {
  return async (req, env, ctx) => {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const session = await getSession(env.DB, token);
    if (!session) return json({ error: "Niet ingelogd of sessie verlopen." }, 401);
    ctx.adminId = session.admin_id;
    ctx.team = session.team_id; // <-- overschrijft het team met wat er écht bij dit account hoort
    return handler(req, env, ctx);
  };
}

// ---------- Assignment engine (server-side, mirrors the React prototype logic) ----------

async function buildCounts(db, team) {
  const functies = functiesVoorTeam(team);
  const personen = await db.prepare("SELECT id FROM personen WHERE team_id = ?").bind(team).all();
  const counts = {};
  personen.results.forEach((p) => {
    counts[p.id] = { total: 0 };
    functies.forEach((f) => (counts[p.id][f] = 0));
  });
  const rows = await db.prepare("SELECT persoon_id, functie_code FROM toewijzingen WHERE handmatig = 0 AND team_id = ?").bind(team).all();
  rows.results.forEach((r) => {
    if (!counts[r.persoon_id]) return;
    counts[r.persoon_id][r.functie_code] = (counts[r.persoon_id][r.functie_code] || 0) + 1;
    counts[r.persoon_id].total += 1;
  });
  return counts;
}

async function getPersonenMetFuncties(db, team) {
  const personen = await db.prepare("SELECT id, naam FROM personen WHERE team_id = ? ORDER BY volgorde, naam").bind(team).all();
  const functieRows = await db.prepare("SELECT persoon_id, functie_code, prioriteit FROM persoon_functies WHERE team_id = ?").bind(team).all();
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

function assignDienst(beschikbarePersonen, counts, functieOrder) {
  const toewijzing = {};
  functieOrder.forEach((f) => (toewijzing[f] = []));
  const reedsIngedeeld = new Set();
  const tekorten = [];

  let remainingSlots = [];
  functieOrder.forEach((code) => {
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

// --- AANGEPAST: gebruikersnaam is nu team-onafhankelijk uniek; team volgt uit het account zelf ---
async function handleLogin(req, env, ctx) {
  const { gebruikersnaam, wachtwoord } = await req.json();
  if (!gebruikersnaam || !wachtwoord) return json({ error: "Gebruikersnaam en wachtwoord verplicht." }, 400);

  const admin = await env.DB.prepare("SELECT id, team_id, wachtwoord_hash FROM admins WHERE gebruikersnaam = ?")
    .bind(gebruikersnaam)
    .first();
  if (!admin) return json({ error: "Onjuiste gebruikersnaam of wachtwoord." }, 401);

  const hash = await sha256(wachtwoord);
  if (hash !== admin.wachtwoord_hash) return json({ error: "Onjuiste gebruikersnaam of wachtwoord." }, 401);

  const token = uid();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, admin_id, team_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(token, admin.id, admin.team_id, expires)
    .run();

  // team_id en team_naam gaan mee terug, zodat de frontend weet in welk team hij is ingelogd
  return json({ token, expires, team_id: admin.team_id, team_naam: naamVoorTeam(admin.team_id) });
}

async function handleGetPersonen(req, env, ctx) {
  const personen = await getPersonenMetFuncties(env.DB, ctx.team);
  return json({ personen });
}

async function handleAddPersoon(req, env, ctx) {
  const team = ctx.team;
  const { naam } = await req.json();
  if (!naam || !naam.trim()) return json({ error: "Naam is verplicht." }, 400);

  const aantal = await env.DB.prepare("SELECT COUNT(*) as n FROM personen WHERE team_id = ?").bind(team).first();
  if (aantal.n >= 10) return json({ error: "Maximaal 10 namen toegestaan." }, 400);

  const id = uid();
  await env.DB.prepare("INSERT INTO personen (id, naam, team_id, volgorde) VALUES (?, ?, ?, ?)")
    .bind(id, naam.trim(), team, aantal.n)
    .run();
  return json({ id, naam: naam.trim() });
}

async function handleDeletePersoon(req, env, ctx) {
  const id = ctx.params.id;
  const team = ctx.team;
  await env.DB.prepare("DELETE FROM personen WHERE id = ? AND team_id = ?").bind(id, team).run();
  return json({ deleted: id });
}

async function handleSetFunctie(req, env, ctx) {
  const personId = ctx.params.id;
  const team = ctx.team;
  const { functie_code, actief, prioriteit } = await req.json();
  if (!functiesVoorTeam(team).includes(functie_code)) return json({ error: "Onbekende functie." }, 400);

  if (actief === false) {
    await env.DB.prepare("DELETE FROM persoon_functies WHERE persoon_id = ? AND functie_code = ? AND team_id = ?")
      .bind(personId, functie_code, team)
      .run();
    return json({ ok: true });
  }

  const prio = prioriteit === "reserve" ? "reserve" : "vast";
  await env.DB.prepare(
    `INSERT INTO persoon_functies (persoon_id, functie_code, team_id, prioriteit) VALUES (?, ?, ?, ?)
     ON CONFLICT(persoon_id, functie_code, team_id) DO UPDATE SET prioriteit = excluded.prioriteit`
  )
    .bind(personId, functie_code, team, prio)
    .run();
  return json({ ok: true });
}

async function handleGetDiensten(req, env, ctx) {
  const team = ctx.team;
  const diensten = await env.DB.prepare("SELECT id, datum FROM diensten WHERE team_id = ? ORDER BY datum").bind(team).all();
  const result = [];
  for (const d of diensten.results) {
    const beschikbaar = await env.DB.prepare("SELECT persoon_id FROM beschikbaarheid WHERE dienst_id = ? AND team_id = ?")
      .bind(d.id, team)
      .all();
    const toewijzing = await env.DB.prepare(
      "SELECT persoon_id, functie_code, handmatig FROM toewijzingen WHERE dienst_id = ? AND team_id = ?"
    )
      .bind(d.id, team)
      .all();
    const tekorten = await env.DB.prepare("SELECT functie_code FROM tekorten WHERE dienst_id = ? AND team_id = ?")
      .bind(d.id, team)
      .all();

    const toewijzingMap = {};
    functiesVoorTeam(team).forEach((f) => (toewijzingMap[f] = []));
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

async function handleAddDienst(req, env, ctx) {
  const team = ctx.team;
  const { datum } = await req.json();
  if (!datum) return json({ error: "Datum is verplicht." }, 400);

  const bestaat = await env.DB.prepare("SELECT id FROM diensten WHERE datum = ? AND team_id = ?").bind(datum, team).first();
  if (bestaat) return json({ error: "Er bestaat al een dienst op deze datum." }, 400);

  const id = uid();
  await env.DB.prepare("INSERT INTO diensten (id, datum, team_id) VALUES (?, ?, ?)").bind(id, datum, team).run();

  const personen = await env.DB.prepare("SELECT id FROM personen WHERE team_id = ?").bind(team).all();
  for (const p of personen.results) {
    await env.DB.prepare("INSERT INTO beschikbaarheid (dienst_id, persoon_id, team_id) VALUES (?, ?, ?)")
      .bind(id, p.id, team)
      .run();
  }

  return json({ id, datum });
}

async function handleAddPeriode(req, env, ctx) {
  const team = ctx.team;
  const { van, tot, interval } = await req.json();
  if (!van || !tot || !interval || interval < 1) return json({ error: "Van, tot en interval zijn verplicht." }, 400);

  const personen = await env.DB.prepare("SELECT id FROM personen WHERE team_id = ?").bind(team).all();
  const bestaande = await env.DB.prepare("SELECT datum FROM diensten WHERE team_id = ?").bind(team).all();
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
    await env.DB.prepare("INSERT INTO diensten (id, datum, team_id) VALUES (?, ?, ?)").bind(id, datum, team).run();
    for (const p of personen.results) {
      await env.DB.prepare("INSERT INTO beschikbaarheid (dienst_id, persoon_id, team_id) VALUES (?, ?, ?)")
        .bind(id, p.id, team)
        .run();
    }
  }

  return json({ aangemaakt: nieuwe.length });
}

async function handleDeleteDienst(req, env, ctx) {
  const id = ctx.params.id;
  const team = ctx.team;
  await env.DB.prepare("DELETE FROM diensten WHERE id = ? AND team_id = ?").bind(id, team).run();
  return json({ deleted: id });
}

async function handleSetBeschikbaar(req, env, ctx) {
  const dienstId = ctx.params.id;
  const team = ctx.team;
  const { persoon_id, beschikbaar } = await req.json();

  if (beschikbaar) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO beschikbaarheid (dienst_id, persoon_id, team_id) VALUES (?, ?, ?)"
    )
      .bind(dienstId, persoon_id, team)
      .run();
  } else {
    await env.DB.prepare("DELETE FROM beschikbaarheid WHERE dienst_id = ? AND persoon_id = ? AND team_id = ?")
      .bind(dienstId, persoon_id, team)
      .run();
  }
  return json({ ok: true });
}

async function handleSetAlleBeschikbaar(req, env, ctx) {
  const dienstId = ctx.params.id;
  const team = ctx.team;
  const { aan } = await req.json();

  await env.DB.prepare("DELETE FROM beschikbaarheid WHERE dienst_id = ? AND team_id = ?").bind(dienstId, team).run();
  if (aan) {
    const personen = await env.DB.prepare("SELECT id FROM personen WHERE team_id = ?").bind(team).all();
    for (const p of personen.results) {
      await env.DB.prepare("INSERT INTO beschikbaarheid (dienst_id, persoon_id, team_id) VALUES (?, ?, ?)")
        .bind(dienstId, p.id, team)
        .run();
    }
  }
  return json({ ok: true });
}

async function handleIndelenEen(req, env, ctx) {
  const dienstId = ctx.params.id;
  const team = ctx.team;
  const allePersonen = await getPersonenMetFuncties(env.DB, team);
  const beschikbaarRows = await env.DB.prepare("SELECT persoon_id FROM beschikbaarheid WHERE dienst_id = ? AND team_id = ?")
    .bind(dienstId, team)
    .all();
  const beschikbaarIds = new Set(beschikbaarRows.results.map((r) => r.persoon_id));
  const beschikbarePersonen = allePersonen.filter((p) => beschikbaarIds.has(p.id));

  const counts = await buildCounts(env.DB, team);
  const { toewijzing, tekorten } = assignDienst(beschikbarePersonen, counts, functiesVoorTeam(team));

  await env.DB.prepare("DELETE FROM toewijzingen WHERE dienst_id = ? AND team_id = ?").bind(dienstId, team).run();
  await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND team_id = ?").bind(dienstId, team).run();

  for (const code of functiesVoorTeam(team)) {
    for (const personId of toewijzing[code]) {
      await env.DB.prepare(
        "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, team_id) VALUES (?, ?, ?, ?)"
      )
        .bind(dienstId, personId, code, team)
        .run();
    }
  }
  for (const code of tekorten) {
    await env.DB.prepare("INSERT INTO tekorten (dienst_id, functie_code, team_id) VALUES (?, ?, ?)")
      .bind(dienstId, code, team)
      .run();
  }

  return json({ toewijzing, tekorten });
}

async function handleWijzigToewijzing(req, env, ctx) {
  const dienstId = ctx.params.id;
  const team = ctx.team;
  const { functie_code, oude_persoon_id, nieuwe_persoon_id } = await req.json();

  if (!functiesVoorTeam(team).includes(functie_code)) return json({ error: "Onbekende functie." }, 400);
  if (!nieuwe_persoon_id) return json({ error: "Nieuwe persoon is verplicht." }, 400);

  const beschikbaar = await env.DB.prepare(
    "SELECT 1 FROM beschikbaarheid WHERE dienst_id = ? AND persoon_id = ? AND team_id = ?"
  )
    .bind(dienstId, nieuwe_persoon_id, team)
    .first();
  if (!beschikbaar) return json({ error: "Deze persoon is niet beschikbaar voor deze dienst." }, 400);

  const magFunctie = await env.DB.prepare(
    "SELECT 1 FROM persoon_functies WHERE persoon_id = ? AND functie_code = ? AND team_id = ?"
  )
    .bind(nieuwe_persoon_id, functie_code, team)
    .first();
  if (!magFunctie) return json({ error: "Deze persoon mag deze functie niet vervullen." }, 400);

  const bestaandeRij = await env.DB.prepare(
    "SELECT functie_code FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ? AND team_id = ?"
  )
    .bind(dienstId, nieuwe_persoon_id, team)
    .first();

  if (bestaandeRij) {
    const huidigeFunctieVanNieuwePersoon = bestaandeRij.functie_code;
    if (huidigeFunctieVanNieuwePersoon === functie_code) {
      return json({ error: "Deze persoon staat hier al ingedeeld." }, 400);
    }
    if (!oude_persoon_id) {
      return json({ error: "Kan niet wisselen: er staat hier niemand om mee te ruilen." }, 400);
    }

    const oudeMagNieuweFunctie = await env.DB.prepare(
      "SELECT 1 FROM persoon_functies WHERE persoon_id = ? AND functie_code = ? AND team_id = ?"
    )
      .bind(oude_persoon_id, huidigeFunctieVanNieuwePersoon, team)
      .first();
    if (!oudeMagNieuweFunctie) {
      return json({ error: "De huidige persoon op deze plek mag de andere functie niet vervullen — wisselen niet mogelijk." }, 400);
    }

    await env.DB.prepare("DELETE FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ? AND team_id = ?")
      .bind(dienstId, oude_persoon_id, team)
      .run();
    await env.DB.prepare("DELETE FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ? AND team_id = ?")
      .bind(dienstId, nieuwe_persoon_id, team)
      .run();
    await env.DB.prepare(
      "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, handmatig, team_id) VALUES (?, ?, ?, 1, ?)"
    )
      .bind(dienstId, nieuwe_persoon_id, functie_code, team)
      .run();
    await env.DB.prepare(
      "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, handmatig, team_id) VALUES (?, ?, ?, 1, ?)"
    )
      .bind(dienstId, oude_persoon_id, huidigeFunctieVanNieuwePersoon, team)
      .run();

    await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND functie_code = ? AND team_id = ?")
      .bind(dienstId, functie_code, team)
      .run();
    await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND functie_code = ? AND team_id = ?")
      .bind(dienstId, huidigeFunctieVanNieuwePersoon, team)
      .run();

    return json({ ok: true, gewisseld: true });
  }

  if (oude_persoon_id) {
    await env.DB.prepare(
      "DELETE FROM toewijzingen WHERE dienst_id = ? AND persoon_id = ? AND functie_code = ? AND team_id = ?"
    )
      .bind(dienstId, oude_persoon_id, functie_code, team)
      .run();
  }

  await env.DB.prepare(
    "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, handmatig, team_id) VALUES (?, ?, ?, 1, ?)"
  )
    .bind(dienstId, nieuwe_persoon_id, functie_code, team)
    .run();

  await env.DB.prepare("DELETE FROM tekorten WHERE dienst_id = ? AND functie_code = ? AND team_id = ?")
    .bind(dienstId, functie_code, team)
    .run();

  return json({ ok: true });
}

async function handleIndelenAlles(req, env, ctx) {
  const team = ctx.team;
  const functies = functiesVoorTeam(team);
  const alleDiensten = await env.DB.prepare("SELECT id FROM diensten WHERE team_id = ? ORDER BY datum").bind(team).all();
  const allePersonen = await getPersonenMetFuncties(env.DB, team);

  await env.DB.prepare("DELETE FROM toewijzingen WHERE team_id = ?").bind(team).run();
  await env.DB.prepare("DELETE FROM tekorten WHERE team_id = ?").bind(team).run();

  const counts = {};
  allePersonen.forEach((p) => {
    counts[p.id] = { total: 0 };
    functies.forEach((f) => (counts[p.id][f] = 0));
  });

  for (const d of alleDiensten.results) {
    const beschikbaarRows = await env.DB.prepare(
      "SELECT persoon_id FROM beschikbaarheid WHERE dienst_id = ? AND team_id = ?"
    )
      .bind(d.id, team)
      .all();
    const beschikbaarIds = new Set(beschikbaarRows.results.map((r) => r.persoon_id));
    const beschikbarePersonen = allePersonen.filter((p) => beschikbaarIds.has(p.id));

    const { toewijzing, tekorten } = assignDienst(beschikbarePersonen, counts, functies);

    for (const code of functies) {
      for (const personId of toewijzing[code]) {
        await env.DB.prepare(
          "INSERT INTO toewijzingen (dienst_id, persoon_id, functie_code, team_id) VALUES (?, ?, ?, ?)"
        )
          .bind(d.id, personId, code, team)
          .run();
      }
    }
    for (const code of tekorten) {
      await env.DB.prepare("INSERT INTO tekorten (dienst_id, functie_code, team_id) VALUES (?, ?, ?)")
        .bind(d.id, code, team)
        .run();
    }
  }

  return json({ ok: true, aantal: alleDiensten.results.length });
}

// --- AANGEPAST: publieke rooster-route geeft nu ook de teamnaam mee, voor de frontend-titel ---
async function handlePubliekRooster(req, env, ctx) {
  const team = ctx.team;
  const personen = await getPersonenMetFuncties(env.DB, team);
  const dienstenResp = await handleGetDiensten(req, env, ctx);
  const dienstenData = await dienstenResp.json();
  return json({ team, team_naam: naamVoorTeam(team), personen, diensten: dienstenData.diensten });
}

// --- NIEUW: lijst van teams, zodat de gast-weergave een keuzemenu kan tonen zonder dit hard te coderen ---
async function handleTeamsLijst(req, env, ctx) {
  const teams = Object.keys(TEAM_FUNCTIES).map((id) => ({ id, naam: naamVoorTeam(id) }));
  return json({ teams });
}

// ---------- Router ----------

const routes = [
  { method: "POST", pattern: /^\/api\/login$/, handler: handleLogin },
  { method: "GET", pattern: /^\/api\/rooster$/, handler: handlePubliekRooster },
  { method: "GET", pattern: /^\/api\/teams$/, handler: handleTeamsLijst },

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
    // X-Team blijft alleen gebruikt voor routes ZONDER sessie (gast-rooster, teams-lijst).
    // Voor ingelogde acties bepaalt de sessie (zie requireAuth) het team, nooit deze header.
    const team = request.headers.get("X-Team") || "veluwsekant";

    if (request.method === "OPTIONS") {
      return json({});
    }

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;

      const ctx = { team };
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
