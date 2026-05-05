const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');

const DB_FILE = path.join(__dirname, 'database.json');
const USERS_FILE = path.join(__dirname, 'users.json');

function readJSON(file) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, '[]');
            return [];
        }

        const data = fs.readFileSync(file, 'utf-8');

        if (!data || data.trim() === '') {
            fs.writeFileSync(file, '[]');
            return [];
        }

        return JSON.parse(data);
    } catch (err) {
        console.error("ERRORE PARSE JSON, RESET FILE:", err);
        try {
            fs.writeFileSync(file, '[]');
        } catch (e) {}
        return [];
    }
}

function writeJSON(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        console.log('SCRITTURA OK:', file);
    } catch (err) {
        console.error('ERRORE SCRITTURA:', err);
    }
}

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

    const users = readJSON(USERS_FILE);

    if (users.find(u => u.username === username)) {
        return res.status(500).json({ error: "utente già esistente" });
    }

    users.push({
        id: Date.now(),
        username,
        password: hash,
        ruolo: 'user'
    });

    writeJSON(USERS_FILE, users);

    res.json({ created: true });
});

// LOGIN
app.post('/login', async (req, res) => {
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

    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.username === username);

    if (!user) {
        return res.status(401).json({ error: "utente non trovato" });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
        return res.status(401).json({ error: "password errata" });
    }

    req.session.user = { id: user.id, username: user.username, ruolo: user.ruolo };

    if (req.headers['content-type'] && req.headers['content-type'].includes('application/x-www-form-urlencoded')) {
        return res.redirect('/');
    }

    res.json({ login: true, user: req.session.user });
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

    const dati = readJSON(DB_FILE);
    res.json(dati);
});

app.post('/scadenze', (req, res) => {
    console.log('BODY RICEVUTO:', req.body);
    const { titolo, descrizione, data_scadenza, priorita } = req.body;
    const prio = priorita || 'bassa';
    if (!titolo || !data_scadenza) {
        return res.status(400).json({ error: "titolo e data_scadenza obbligatori" });
    }

    const dati = readJSON(DB_FILE);

    const nuova = {
        id: Date.now(),
        titolo,
        descrizione,
        data_scadenza,
        priorita: prio
    };

    dati.push(nuova);
    writeJSON(DB_FILE, dati);
    console.log('DATI SALVATI:', dati);

    res.json(nuova);
});

app.put('/scadenze/:id', (req, res) => {
    const { titolo, data_scadenza, priorita } = req.body;
    const prio = priorita || 'bassa';
    if (!titolo || !data_scadenza) {
        return res.status(400).json({ error: "titolo e data_scadenza obbligatori" });
    }

    let dati = readJSON(DB_FILE);

    dati = dati.map(s => {
        if (s.id == req.params.id) {
            return { ...s, titolo, data_scadenza, priorita: prio };
        }
        return s;
    });

    writeJSON(DB_FILE, dati);

    res.json({ updated: true });
});

app.delete('/scadenze/:id', (req, res) => {
    let dati = readJSON(DB_FILE);

    const nuovaLista = dati.filter(s => s.id != req.params.id);

    writeJSON(DB_FILE, nuovaLista);

    res.json({ deleted: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(3000, '0.0.0.0', () => console.log("Server avviato su rete locale porta 3000"));
