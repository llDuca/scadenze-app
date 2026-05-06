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

const DEFAULT_PERMISSIONS = {
    canCreateScadenze: false,
    canEditScadenze: false,
    canDeleteScadenze: false
};

const ADMIN_PERMISSIONS = {
    canCreateScadenze: true,
    canEditScadenze: true,
    canDeleteScadenze: true
};

function normalizzaPermessi(user) {
    if (user?.ruolo === 'admin') return { ...ADMIN_PERMISSIONS };

    return {
        canCreateScadenze: Boolean(user?.permissions?.canCreateScadenze),
        canEditScadenze: Boolean(user?.permissions?.canEditScadenze),
        canDeleteScadenze: Boolean(user?.permissions?.canDeleteScadenze)
    };
}

function utentePubblico(user) {
    return {
        id: user.id,
        username: user.username,
        ruolo: user.ruolo || 'user',
        permissions: normalizzaPermessi(user)
    };
}

function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: "non autenticato" });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: "non autenticato" });
    if (req.session.user.ruolo !== 'admin') return res.status(403).json({ error: "permesso negato" });
    next();
}

function requireScadenzePermission(permission) {
    return (req, res, next) => {
        if (!req.session.user) return res.status(401).json({ error: "non autenticato" });
        const permissions = normalizzaPermessi(req.session.user);
        if (req.session.user.ruolo !== 'admin' && !permissions[permission]) {
            return res.status(403).json({ error: "permesso negato" });
        }
        next();
    };
}

function normalizzaTesto(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseData(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    const raw = String(value).trim();
    let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
    if (match) {
        let first = Number(match[1]);
        let second = Number(match[2]);
        let year = Number(match[3]);
        const hasFullYear = match[3].length === 4;
        if (year < 100) year += 2000;

        const dayFirst = hasFullYear || first > 12;
        const day = dayFirst ? first : second;
        const month = dayFirst ? second : first;

        return new Date(year, month - 1, day);
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formattaData(value) {
    const date = parseData(value);
    if (!date) return value;

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());

    return `${day}/${month}/${year}`;
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

function estraiNoteDettagli(r) {
    return Object.entries(r)
        .filter(([key, value]) =>
            normalizzaTesto(key).includes('dettagli') &&
            value !== undefined &&
            value !== null &&
            String(value).trim() !== ''
        )
        .map(([key, value]) => {
            const label = String(key)
                .replace(/_?dettagli_?/ig, ' ')
                .replace(/_/g, ' ')
                .trim() || 'Dettagli';

            return `${label}: ${String(value).trim()}`;
        })
        .join('\n');
}

function mappaRigaExcel(r, options = {}) {
    const cliente = r.Cliente || r.cliente || r["Nome Cliente"];
    const prodotto = r.Prodotto || r.prodotto || r["Software"] || options.prodottoDefault;
    const tipo_licenza = r["Tipo Licenza"] || r.Tipo || r.tipo_licenza || r.Licenza;
    let data_scadenza = r.Scadenza || r.data_scadenza || r["Data Scadenza"];
    const note = r.Note || r.note || estraiNoteDettagli(r);

    if (typeof data_scadenza === 'number') {
        const date = XLSX.SSF.parse_date_code(data_scadenza);
        data_scadenza = `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
    }

    return {
        cliente,
        prodotto,
        tipo_licenza,
        data_scadenza: formattaData(data_scadenza),
        rinnovo_mensile: Number(r.Rinnovo || r.rinnovo_mensile || r.mensilita || 0),
        note
    };
}

function mappaRigaO365(r, options = {}) {
    const cliente = r.cliente || r.Cliente;
    const prodotto = options.prodottoDefault || 'O365';
    const tipo_licenza = r.tipo_licenza || r["Tipo Licenza"];
    const data_scadenza = formattaData(r.data_scadenza || r.Scadenza);
    const rinnovoRaw = String(r.rinnovo_mensile || '').trim();
    const rinnovo_mensile = Number.parseInt(rinnovoRaw, 10) || Number(r.rinnovo_mensile) || 0;
    const noteParts = [];

    if (r.id_dettagli != null && String(r.id_dettagli).trim() !== '') noteParts.push(`id_dettagli: ${String(r.id_dettagli).trim()}`);
    if (r.IdCliente_dettagli != null && String(r.IdCliente_dettagli).trim() !== '') noteParts.push(`IdCliente_dettagli: ${String(r.IdCliente_dettagli).trim()}`);
    if (r.NrLicenza_dettagli != null && String(r.NrLicenza_dettagli).trim() !== '') noteParts.push(`NrLicenza_dettagli: ${String(r.NrLicenza_dettagli).trim()}`);
    if (r.data_rinnovo != null && String(r.data_rinnovo).trim() !== '') noteParts.push(`data_rinnovo: ${formattaData(r.data_rinnovo)}`);

    return {
        cliente,
        prodotto,
        tipo_licenza,
        data_scadenza,
        rinnovo_mensile,
        note: noteParts.join('\n')
    };
}

function salvaScadenza(scadenze, clienti, payload, options = {}) {
    const { cliente, prodotto, tipo_licenza, data_scadenza, rinnovo_mensile, note } = payload;

    if (!cliente || !prodotto || !tipo_licenza || !data_scadenza) {
        return null;
    }

    const clienteRecord = ensureCliente(clienti, cliente);
    const notePulite = String(note || '').trim();
    const dataFormattata = formattaData(data_scadenza);
    const esiste = scadenze.find(s =>
        s.cliente_id === clienteRecord.id &&
        s.prodotto === prodotto &&
        s.tipo_licenza === tipo_licenza &&
        normalizzaTesto(s.note || '') === normalizzaTesto(notePulite)
    );

    if (esiste) {
        if (!options.aggiornaEsistente) {
            return { scadenza: esiste, creata: false, duplicata: true };
        }

        esiste.data_scadenza = dataFormattata;
        esiste.rinnovo_mensile = Number(rinnovo_mensile) || 0;
        esiste.note = notePulite;
        return { scadenza: esiste, creata: false, duplicata: false };
    }

    const nuova = {
        id: creaScadenzaId(scadenze, {
            cliente_id: clienteRecord.id,
            prodotto,
            tipo_licenza,
            data_scadenza: dataFormattata
        }),
        cliente_id: clienteRecord.id,
        prodotto,
        tipo_licenza,
        data_scadenza: dataFormattata,
        rinnovo_mensile: Number(rinnovo_mensile) || 0,
        note: notePulite
    };

    scadenze.push(nuova);
    return { scadenza: nuova, creata: true, duplicata: false };
}

function importaDaFileExcel(filePath, options = {}) {
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
    const mapper = typeof options.mapper === 'function'
        ? options.mapper
        : (row, cfg) => mappaRigaExcel(row, cfg);

    rows.forEach(r => {
        const result = salvaScadenza(scadenze, clienti, mapper(r, options), { aggiornaEsistente: true });
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

function aggiornaSessioneUtente(req, user) {
    req.session.user = utentePubblico(user);
}

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

    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.username === username);

    if (!user) {
        return res.status(401).json({ error: "utente non trovato" });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
        return res.status(401).json({ error: "password errata" });
    }

    aggiornaSessioneUtente(req, user);

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

app.get('/admin/users', requireAdmin, (req, res) => {
    const users = readJSON(USERS_FILE);
    res.json(users.map(utentePubblico));
});

app.post('/admin/users', requireAdmin, async (req, res) => {
    const { username, password, ruolo, permissions } = req.body;
    const cleanUsername = String(username || '').trim();

    if (!cleanUsername || !password) {
        return res.status(400).json({ error: "username e password obbligatori" });
    }

    const users = readJSON(USERS_FILE);
    if (users.some(u => normalizzaTesto(u.username) === normalizzaTesto(cleanUsername))) {
        return res.status(400).json({ error: "utente già esistente" });
    }

    const user = {
        id: Date.now(),
        username: cleanUsername,
        password: await bcrypt.hash(password, 10),
        ruolo: ruolo === 'admin' ? 'admin' : 'user',
        permissions: ruolo === 'admin' ? ADMIN_PERMISSIONS : {
            ...DEFAULT_PERMISSIONS,
            ...permissions
        }
    };

    users.push(user);
    writeJSON(USERS_FILE, users);
    res.json({ created: true, user: utentePubblico(user) });
});

app.put('/admin/users/:id', requireAdmin, async (req, res) => {
    const { username, password, ruolo, permissions } = req.body;
    const users = readJSON(USERS_FILE);
    const userId = String(req.params.id);
    const index = users.findIndex(u => String(u.id) === userId);

    if (index === -1) return res.status(404).json({ error: "utente non trovato" });

    const cleanUsername = String(username || '').trim();
    if (!cleanUsername) return res.status(400).json({ error: "username obbligatorio" });

    if (users.some(u => String(u.id) !== userId && normalizzaTesto(u.username) === normalizzaTesto(cleanUsername))) {
        return res.status(400).json({ error: "username già usato" });
    }

    const nextRole = ruolo === 'admin' ? 'admin' : 'user';
    users[index].username = cleanUsername;
    users[index].ruolo = nextRole;
    users[index].permissions = nextRole === 'admin' ? ADMIN_PERMISSIONS : {
        ...DEFAULT_PERMISSIONS,
        ...permissions
    };

    if (password) {
        users[index].password = await bcrypt.hash(password, 10);
    }

    writeJSON(USERS_FILE, users);

    if (String(req.session.user.id) === userId) {
        aggiornaSessioneUtente(req, users[index]);
    }

    res.json({ updated: true, user: utentePubblico(users[index]) });
});

app.delete('/admin/users/:id', requireAdmin, (req, res) => {
    const userId = String(req.params.id);
    if (String(req.session.user.id) === userId) {
        return res.status(400).json({ error: "non puoi eliminare l'utente con cui sei collegato" });
    }

    const users = readJSON(USERS_FILE);
    const target = users.find(u => String(u.id) === userId);
    if (!target) return res.status(404).json({ error: "utente non trovato" });
    if (target.ruolo === 'admin') {
        return res.status(400).json({ error: "gli account admin non possono essere eliminati" });
    }

    const nextUsers = users.filter(u => String(u.id) !== userId);

    writeJSON(USERS_FILE, nextUsers);
    res.json({ deleted: true });
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

app.get('/scadenze', requireAuth, (req, res) => {
    const scadenze = readJSON(DB_FILE);
    const clienti = readJSON(CLIENTI_FILE);
    const dati = arricchisciScadenze(scadenze, clienti);
    console.log('LETTURA DB:', dati);
    res.json(dati);
});

app.get('/clienti', requireAuth, (req, res) => {
    res.json(readJSON(CLIENTI_FILE));
});

app.post('/scadenze', requireScadenzePermission('canCreateScadenze'), (req, res) => {
    console.log('BODY RICEVUTO:', req.body);

    const { cliente, prodotto, tipo_licenza, data_scadenza, rinnovo_mensile, note } = req.body;

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
        rinnovo_mensile,
        note
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

app.put('/scadenze/:id', requireScadenzePermission('canEditScadenze'), (req, res) => {
    const { cliente, prodotto, tipo_licenza, data_scadenza, rinnovo_mensile, note } = req.body;

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
                data_scadenza: formattaData(data_scadenza),
                rinnovo_mensile: Number(rinnovo_mensile) || 0,
                note: String(note || '').trim()
            };
        }
        return s;
    });

    writeJSON(CLIENTI_FILE, clienti);
    writeJSON(DB_FILE, scadenze);

    res.json({ updated: true });
});

app.delete('/scadenze/:id', requireScadenzePermission('canDeleteScadenze'), (req, res) => {
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
        const imports = [
            { filePath: path.join(__dirname, 'Licenze3CX.xlsx') },
            { filePath: path.join(__dirname, 'LicenzeFortigate.xlsx'), prodottoDefault: 'Fortigate' },
            { filePath: path.join(__dirname, 'LicenzeEset.xlsx'), prodottoDefault: 'ESET' }
        ];

        imports.forEach(importConfig => {
            const result = importaDaFileExcel(importConfig.filePath, importConfig);
            if (!result.imported) return console.log(result.message);

            console.log("IMPORT AUTOMATICO OK:", path.basename(importConfig.filePath), result);
        });

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

app.post('/import-fortigate', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'LicenzeFortigate.xlsx');
        const result = importaDaFileExcel(filePath, { prodottoDefault: 'Fortigate' });

        if (!result.imported) {
            return res.status(400).json({ error: result.message });
        }

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Errore import Fortigate' });
    }
});

app.post('/import-eset', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'LicenzeEset.xlsx');
        const result = importaDaFileExcel(filePath, { prodottoDefault: 'ESET' });

        if (!result.imported) {
            return res.status(400).json({ error: result.message });
        }

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Errore import ESET' });
    }
});

app.post('/import-o365', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'LicenzeO365.xlsx');
        const result = importaDaFileExcel(filePath, { prodottoDefault: 'O365', mapper: mappaRigaO365 });

        if (!result.imported) {
            return res.status(400).json({ error: result.message });
        }

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Errore import O365' });
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

app.get('/import-fortigate', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'LicenzeFortigate.xlsx');
        const result = importaDaFileExcel(filePath, { prodottoDefault: 'Fortigate' });

        if (!result.imported) {
            return res.status(400).send(result.message);
        }

        res.send(`Import Fortigate completato. Aggiunte: ${result.aggiunte}. Aggiornate: ${result.aggiornate}. Totale scadenze: ${result.totale}`);

    } catch (err) {
        console.error(err);
        res.status(500).send('Errore import Fortigate');
    }
});

app.get('/import-eset', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'LicenzeEset.xlsx');
        const result = importaDaFileExcel(filePath, { prodottoDefault: 'ESET' });

        if (!result.imported) {
            return res.status(400).send(result.message);
        }

        res.send(`Import ESET completato. Aggiunte: ${result.aggiunte}. Aggiornate: ${result.aggiornate}. Totale scadenze: ${result.totale}`);

    } catch (err) {
        console.error(err);
        res.status(500).send('Errore import ESET');
    }
});

app.get('/import-o365', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'LicenzeO365.xlsx');
        const result = importaDaFileExcel(filePath, { prodottoDefault: 'O365', mapper: mappaRigaO365 });

        if (!result.imported) {
            return res.status(400).send(result.message);
        }

        res.send(`Import O365 completato. Aggiunte: ${result.aggiunte}. Aggiornate: ${result.aggiornate}. Totale scadenze: ${result.totale}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Errore import O365');
    }
});

cron.schedule('0 * * * *', () => {
    console.log('ESEGUO IMPORT AUTOMATICO...');
    importaExcelAutomatico();
});

app.listen(3000, '0.0.0.0', () => console.log("Server avviato su rete locale porta 3000"));
