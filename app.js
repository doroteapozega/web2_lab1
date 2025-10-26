// napomena: nisam sigurna gdje ovo navesti pa navodim ovdje, koristila sam se ChatGPT-om kada bih negdje zapela,
// npr. navela sam bas za qr kod jer sam ga tu najvise koristila, ali isto tako ako bi mi se izbacivala neka greska,
// poslala bi ChatGPT-u prompt da mi pomogne sa time (zato svugdje imam ovaj console.error(err) jer nisam mogla skuzit
// di je problem bio pa mi je on preporucio da to svugdje dodam), ili bih guglala ili pogledala youtube tutorial,
// isto to bih napravila ako bi se susrela s necim sto do sada nisam radila i sto ne znam pa bi opet ili
// potrazila na internetu ili pitala AI da mi objasni sto je to i kako se implementira (npr. taj qr, i ovaj m2m isto)

// import potrebnih paketa
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const express = require("express");
const pool = require("./db.js");
const { expressjwt: jwt } = require("express-jwt");
const jwksRsa = require("jwks-rsa");
const { auth, requiresAuth } = require("express-openid-connect");

// osnovna konfiguracija aplikacije za rad
dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

// konfiguracija autentifikacije (prijava korisnika)
const config = {
  authRequired: false, // nije u cijeloj aplikaciji potrebno (pocetna se prikaze svima npr.)
  auth0Logout: true,
  secret: process.env.SESSION_SECRET,
  baseURL: process.env.AUTH0_BASE_URL,
  clientID: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  authorizationParams: {
    response_type: "code",
    scope: "openid profile email",
    audience: process.env.AUTH0_AUDIENCE,
  },
};
app.use(auth(config));

// konfiguracija provjere ispravnosti JWT tokena
const jwtCheck = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  }),
  audience: process.env.AUTH0_AUDIENCE,
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  algorithms: ["RS256"],
});

// pocetna stranica
app.get("/", async (req, res) => {
  try {
    const runda = await pool.query(
      "SELECT * FROM rounds ORDER BY id DESC LIMIT 1"
    );
    const currentRound = runda.rows[0] || null;
    let ticketsCount = null;
    if (currentRound) {
      const tc = await pool.query(
        "SELECT COUNT(*) FROM tickets WHERE round_id = $1",
        [currentRound.id]
      );
      ticketsCount = parseInt(tc.rows[0].count, 10);
    }
    let user = null;
    // ako je prijavljen izvlacimo podatke o korisniku
    if (req.oidc && req.oidc.isAuthenticated()) {
      user = req.oidc.user;
    }
    return res.render("index", { user, currentRound, ticketsCount });
  } catch (err) {
    console.error(err);
  }
});

// aktivacija nove runde (kola)
app.post("/new-round", jwtCheck, async (req, res) => {
  try {
    const aktivno = await pool.query(
      "SELECT id FROM rounds WHERE active = TRUE LIMIT 1"
    );
    // ako pokusamo aktivirati kolo koje je vec aktivirano salje se 204 (no content)
    if (aktivno.rows.length > 0) {
      return res.status(204).send();
    }
    await pool.query("INSERT INTO rounds (active) VALUES (TRUE)");
    return res.status(204).send();
  } catch (err) {
    console.error(err);
  }
});

// deaktivacija trenutnog kola
app.post("/close", jwtCheck, async (req, res) => {
  try {
    await pool.query("UPDATE rounds SET active = FALSE WHERE active = TRUE");
    res.status(204).send();
  } catch (err) {
    console.error(err);
  }
});

// spremanje rezultata
app.post("/store-results", jwtCheck, async (req, res) => {
  try {
    const { numbers } = req.body;
    // jedina situacija kad mozemo spremiti rezultat je ako je kolo deaktivirano a brojevi jos nisu izvuceni
    const provjera = await pool.query(
      "SELECT * FROM rounds WHERE active = FALSE AND numbers IS NULL ORDER BY id DESC LIMIT 1"
    );
    // ako nema takvog slucaja saljemo gresku
    if (provjera.rows.length === 0) {
      return res.status(400).send("Bad Request");
    }
    const round = provjera.rows[0];
    await pool.query("UPDATE rounds SET numbers = $1 WHERE id = $2", [
      numbers,
      round.id,
    ]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
  }
});

// kupnja listica i spremanja u bazu
app.post("/ticket", requiresAuth(), async (req, res) => {
  try {
    const { national_id, numbers } = req.body;
    // prvo se provjerava ima li aktivnog kola
    const aktiv = await pool.query(
      "SELECT * FROM rounds WHERE active = TRUE ORDER BY id DESC LIMIT 1"
    );
    if (aktiv.rows.length === 0) {
      return res.status(400).send("Nema aktivnog kola za uplatu");
    }
    const round = aktiv.rows[0];
    // provjeravamo jesu li unijeti podaci u dobrom formatu
    if (
      !national_id ||
      typeof national_id !== "string" ||
      national_id.length > 20 ||
      !Array.isArray(numbers) ||
      numbers.length < 6 ||
      numbers.length > 10 ||
      numbers.some(
        (n) => typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 45
      ) ||
      new Set(numbers).size !== numbers.length // set automatski mice duplikate pa ako nije iste velicine kao numbers ocito ima duplikata
    ) {
      return res.status(400).send("Neispravni podaci za unos!");
    }
    const ticketId = uuidv4();
    await pool.query(
      "INSERT INTO tickets (id, national_id, numbers, round_id) VALUES ($1, $2, $3, $4)",
      [ticketId, national_id, numbers, round.id]
    );
    // dio za generiranje slike qr koda (tu mi je chatGPT puno pomagao, i za ovaj dio i za onaj u buy.ejs takoder)
    const base = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const ticketUrl = `${base.replace(/\/$/, "")}/ticket/${ticketId}`;
    const qrImage = await QRCode.toBuffer(ticketUrl);
    res.setHeader("Content-Type", "image/png");
    return res.send(qrImage);
  } catch (err) {
    console.error(err);
  }
});

// prikaz podataka o kupljenom listicu
app.get("/ticket/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // zelimo info za taj listic
    const t = await pool.query(
      "SELECT id, national_id, numbers, round_id, created_at FROM tickets WHERE id = $1",
      [id]
    );
    // ako ne postoji listic s tim id vrati gresku
    if (t.rows.length === 0) {
      return res.status(404).send("Cannot GET /ticket/" + id);
    }
    // trebamo info i za rundu (da saznamo izvucene listice ako ih ima)
    const ticket = t.rows[0];
    const r = await pool.query(
      "SELECT id, numbers, active FROM rounds WHERE id = $1",
      [ticket.round_id]
    );
    const round = r.rows[0] || null;
    return res.render("ticket", { ticket, round });
  } catch (err) {
    console.error(err);
  }
});

// vodi na formu za kupnju listica
app.get("/buy", requiresAuth(), async (req, res) => {
  try {
    const aktiv = await pool.query(
      "SELECT * FROM rounds WHERE active = TRUE ORDER BY id DESC LIMIT 1"
    );
    // provjeravamo ima li aktivnih rundi i saljemo podatak dalje (forma za uplatu ce se prikazati samo ako ima, rjeseno u buy.ejs)
    let round = null;
    if (aktiv.rows.length > 0) {
      round = aktiv.rows[0];
    }
    return res.render("buy", { user: req.oidc.user, round });
  } catch (err) {
    console.error(err);
  }
});

// pokretanje servera
const PORT = process.env.PORT || 3000;
app.listen(PORT);

// izbacuje zadanu gresku ako se u bilo kojem trenutku desi greska provjerom JWT tokena
app.use((err, req, res, next) => {
  if (err && err.name === "UnauthorizedError") {
    return res.status(401).json({ error: "Neispravan ili nedostajući token!" });
  }
  console.error(err);
});
