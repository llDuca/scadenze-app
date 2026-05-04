const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const session = require('express-session');

app.use(session({
    secret: 'tecnotel-secret',
    resave: false,
    saveUninitialized: false
}));

app.use(express.static(path.join(__dirname, 'frontend')));

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS scadenze (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titolo TEXT,
        descrizione TEXT,
        data_scadenza TEXT,
        priorita TEXT DEFAULT 'bassa'
    )
    `);

    db.run(`
    CREATE TABLE IF NOT EXISTS utenti (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        ruolo TEXT
    )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_scadenze_data ON scadenze(data_scadenza)`);
});

// PAGINA TEST REGISTRAZIONE (browser)
app.get('/register', (req, res) => {
    res.send(`
        <html>
        <body style="font-family:sans-serif;padding:20px;">
            <h2>Test Registrazione</h2>
            <form method="POST" action="/register">
                <input name="username" placeholder="username" required/><br><br>
                <input name="password" type="password" placeholder="password" required/><br><br>
                <button type="submit">Registrati</button>
            </form>
        </body>
        </html>
    `);
});

// REGISTRAZIONE
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "username e password obbligatori" });
    }

    const hash = await bcrypt.hash(password, 10);

    db.run(
        "INSERT INTO utenti (username, password, ruolo) VALUES (?, ?, ?)",
        [username, hash, 'user'],
        function(err) {
            if (err) return res.status(500).json({ error: "utente già esistente" });
            res.json({ created: true });
        }
    );
});

// LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    // LOGIN HARDCODED TECNOTEL
    if (username === "Tecnotel" && password === "t3cn0t3l!") {
        req.session.user = { id: 0, username: "Tecnotel", ruolo: "admin" };
        // Se arriva da form HTML, fai redirect alla dashboard
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/x-www-form-urlencoded')) {
            return res.redirect('/');
        }
        return res.json({ login: true, user: req.session.user });
    }

    db.get("SELECT * FROM utenti WHERE username = ?", [username], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: "utente non trovato" });
        }

        const valid = await bcrypt.compare(password, user.password);

        if (!valid) {
            return res.status(401).json({ error: "password errata" });
        }

        req.session.user = { id: user.id, username: user.username, ruolo: user.ruolo };
        // Se arriva da form HTML, fai redirect alla dashboard
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/x-www-form-urlencoded')) {
            return res.redirect('/');
        }
        res.json({ login: true, user: req.session.user });
    });
});

// CHECK LOGIN
app.get('/me', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ logged: false });
    }
    res.json({ logged: true, user: req.session.user });
});

// LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(() => {});
    res.redirect('/login');
});

// PAGINA LOGIN (browser)
app.get('/login', (req, res) => {
    res.send(`
        <html>
        <body style="font-family:sans-serif;padding:20px;">
            <h2>Login Tecnotel</h2>
            <form method="POST" action="/login">
                <input name="username" placeholder="username" required/><br><br>
                <input name="password" type="password" placeholder="password" required/><br><br>
                <button type="submit">Accedi</button>
            </form>
        </body>
        </html>
    `);
});

app.get('/scadenze', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "non autenticato" });

    db.all("SELECT * FROM scadenze ORDER BY data_scadenza ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/scadenze', (req, res) => {
    const { titolo, descrizione, data_scadenza, priorita } = req.body;
    const prio = priorita || 'bassa';
    if (!titolo || !data_scadenza) {
        return res.status(400).json({ error: "titolo e data_scadenza obbligatori" });
    }
    db.run(
        "INSERT INTO scadenze (titolo, descrizione, data_scadenza, priorita) VALUES (?, ?, ?, ?)",
        [titolo, descrizione, data_scadenza, prio],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
});

app.put('/scadenze/:id', (req, res) => {
    const { titolo, data_scadenza, priorita } = req.body;
    const prio = priorita || 'bassa';
    if (!titolo || !data_scadenza) {
        return res.status(400).json({ error: "titolo e data_scadenza obbligatori" });
    }
    db.run(
        "UPDATE scadenze SET titolo = ?, data_scadenza = ?, priorita = ? WHERE id = ?",
        [titolo, data_scadenza, prio, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ updated: true });
        }
    );
});

app.delete('/scadenze/:id', (req, res) => {
    db.run("DELETE FROM scadenze WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes > 0 });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(3000, '0.0.0.0', () => console.log("Server avviato su rete locale porta 3000"));
