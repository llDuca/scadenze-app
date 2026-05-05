const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const XLSX = require('xlsx');
const cron = require('node-cron');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'database.json');
const CLIENTI_FILE = path.join(__dirname, 'clienti.json');
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

function normalizzaTesto(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function creaClienteId(nome) {
    const pulito = normalizzaTesto(nome);
    const slug = pulito
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'cliente';
    const hash = crypto.createHash('sha1').update(pulito).digest('hex').slice(0, 10);

    return `cli_${slug}_${hash}`;
}

function creaScadenzaId(scadenze, payload) {
    const seed = [
        payload.cliente_id,
        payload.prodotto,
        payload.tipo_licenza,
        payload.data_scadenza,
        Date.now(),
        Math.random()
    ].join('|');
    const base = `sca_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
    let id = base;
    let contatore = 2;

    while (scadenze.some(s => s.id === id)) {
        id = `${base}_${contatore}`;
        contatore++;
    }

    return id;
}

function trovaCliente(clienti, nome) {
    const normalizzato = normalizzaTesto(nome);
    return clienti.find(c => normalizzaTesto(c.nome) === normalizzato);
}

function trovaClientePerId(clienti, id) {
    return clienti.find(c => c.id === id);
}

function ensureCliente(clienti, nome) {
    const nomePulito = String(nome || '').trim().replace(/\s+/g, ' ');
    let cliente = trovaCliente(clienti, nomePulito);

    if (cliente) return cliente;

    let id = creaClienteId(nomePulito);
    let contatore = 2;
    while (clienti.some(c => c.id === id)) {
        id = `${creaClienteId(nomePulito)}_${contatore}`;
        contatore++;
    }

    cliente = {
        id,
        nome: nomePulito,
        created_at: new Date().toISOString()
    };

    clienti.push(cliente);
    return cliente;
}

function arricchisciScadenze(scadenze, clienti) {
    return scadenze.map(s => {
        const cliente = trovaClientePerId(clienti, s.cliente_id);
        return {
            ...s,
            cliente: cliente ? cliente.nome : (s.cliente || '')
        };
    });
}

function mappaRigaExcel(r) {
    const cliente = r.Cliente || r.cliente || r["Nome Cliente"];
    const prodotto = r.Prodotto || r.prodotto || r["Software"];
    const tipo_licenza = r["Tipo Licenza"] || r.Tipo || r.tipo_licenza || r.Licenza;
    let data_scadenza = r.Scadenza || r.data_scadenza || r["Data Scadenza"];

    if (typeof data_scadenza === 'number') {
        const date = XLSX.SSF.parse_date_code(data_scadenza);
        data_scadenza = `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
    }

    return {
        cliente,
        prodotto,
        tipo_licenza,
        data_scadenza,
        rinnovo_mensile: Number(r.Rinnovo || r.rinnovo_mensile || r.mensilita || 0)
    };
}

function salvaScadenza(scadenze, clienti, payload, options = {}) {
    const { cliente, prodotto, tipo_licenza, data_scadenza, rinnovo_mensile } = payload;

    if (!cliente || !prodotto || !tipo_licenza || !data_scadenza) {
        return null;
    }

    const clienteRecord = ensureCliente(clienti, cliente);
    const esiste = scadenze.find(s =>
        s.cliente_id === clienteRecord.id &&
        s.prodotto === prodotto &&
        s.tipo_licenza === tipo_licenza
    );

    if (esiste) {
        if (!options.aggiornaEsistente) {
            return { scadenza: esiste, creata: false, duplicata: true };
        }

        esiste.data_scadenza = data_scadenza;
        esiste.rinnovo_mensile = Number(rinnovo_mensile) || 0;
        return { scadenza: esiste, creata: false, duplicata: false };
    }

    const nuova = {
        id: creaScadenzaId(scadenze, {
            cliente_id: clienteRecord.id,
            prodotto,
            tipo_licenza,
            data_scadenza
        }),
        cliente_id: clienteRecord.id,
        prodotto,
        tipo_licenza,
        data_scadenza,
        rinnovo_mensile: Number(rinnovo_mensile) || 0
    };

    scadenze.push(nuova);
    return { scadenza: nuova, creata: true, duplicata: false };
}

function importaDaFileExcel(filePath) {
    if (!fs.existsSync(filePath)) {
        return { imported: false, message: 'File Excel non trovato', totale: 0, aggiunte: 0 };
    }

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { raw: false });

    const clienti = readJSON(CLIENTI_FILE);
    const scadenze = readJSON(DB_FILE);
    let aggiunte = 0;
    let aggiornate = 0;

    rows.forEach(r => {
        const result = salvaScadenza(scadenze, clienti, mappaRigaExcel(r), { aggiornaEsistente: true });
        if (result?.creata) aggiunte++;
        else if (result && !result.duplicata) aggiornate++;
    });

    writeJSON(CLIENTI_FILE, clienti);
    writeJSON(DB_FILE, scadenze);

    return { imported: true, totale: scadenze.length, aggiunte, aggiornate };
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
    res.sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

app.get('/scadenze', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "non autenticato" });

    const scadenze = readJSON(DB_FILE);
    const clienti = readJSON(CLIENTI_FILE);
    const dati = arricchisciScadenze(scadenze, clienti);
    console.log('LETTURA DB:', dati);
    res.json(dati);
});

app.get('/clienti', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "non autenticato" });

    res.json(readJSON(CLIENTI_FILE));
});

app.post('/scadenze', (req, res) => {
    console.log('BODY RICEVUTO:', req.body);

    const { cliente, prodotto, tipo_licenza, data_scadenza, rinnovo_mensile } = req.body;

    if (!cliente || !prodotto || !tipo_licenza || !data_scadenza) {
        return res.status(400).json({ error: "campi obbligatori mancanti" });
    }

    const clienti = readJSON(CLIENTI_FILE);
    const scadenze = readJSON(DB_FILE);
    const result = salvaScadenza(scadenze, clienti, {
        cliente,
        prodotto,
        tipo_licenza,
        data_scadenza,
        rinnovo_mensile
    });

    if (!result || result.duplicata) {
        return res.status(400).json({ error: "Licenza già esistente per questo cliente" });
    }

    writeJSON(CLIENTI_FILE, clienti);
    writeJSON(DB_FILE, scadenze);
    console.log('FILE DB:', DB_FILE);
    const verifica = readJSON(DB_FILE);
    console.log('VERIFICA FILE:', verifica);

    console.log('DATI SALVATI:', result.scadenza);

    const clienteRecord = trovaClientePerId(clienti, result.scadenza.cliente_id);
    res.json({ ...result.scadenza, cliente: clienteRecord ? clienteRecord.nome : cliente });
});

app.put('/scadenze/:id', (req, res) => {
    const { cliente, prodotto, tipo_licenza, data_scadenza, rinnovo_mensile } = req.body;

    if (!cliente || !prodotto || !tipo_licenza || !data_scadenza) {
        return res.status(400).json({ error: "campi obbligatori mancanti" });
    }

    const clienti = readJSON(CLIENTI_FILE);
    let scadenze = readJSON(DB_FILE);
    const clienteRecord = ensureCliente(clienti, cliente);

    scadenze = scadenze.map(s => {
        if (s.id == req.params.id) {
            return {
                ...s,
                cliente_id: clienteRecord.id,
                prodotto,
                tipo_licenza,
                data_scadenza,
                rinnovo_mensile: Number(rinnovo_mensile) || 0
            };
        }
        return s;
    });

    writeJSON(CLIENTI_FILE, clienti);
    writeJSON(DB_FILE, scadenze);

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

function importaExcelAutomatico() {
    try {
        const filePath = path.join(__dirname, 'Licenze3CX.xlsx');

        const result = importaDaFileExcel(filePath);
        if (!result.imported) return console.log(result.message);

        console.log("IMPORT AUTOMATICO OK:", result);

    } catch (err) {
        console.error("ERRORE IMPORT AUTO:", err);
    }
}

// Import Excel endpoint
app.post('/import-excel', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'Licenze3CX.xlsx');
        const result = importaDaFileExcel(filePath);

        if (!result.imported) {
            return res.status(400).json({ error: result.message });
        }

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Errore import Excel' });
    }
});

app.get('/import-excel', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'Licenze3CX.xlsx');
        const result = importaDaFileExcel(filePath);

        if (!result.imported) {
            return res.status(400).send(result.message);
        }

        res.send(`Import completato. Aggiunte: ${result.aggiunte}. Aggiornate: ${result.aggiornate}. Totale scadenze: ${result.totale}`);

    } catch (err) {
        console.error(err);
        res.status(500).send('Errore import');
    }
});

cron.schedule('0 * * * *', () => {
    console.log('ESEGUO IMPORT AUTOMATICO...');
    importaExcelAutomatico();
});

app.listen(3000, '0.0.0.0', () => console.log("Server avviato su rete locale porta 3000"));
