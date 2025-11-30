const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

let DB = { reservations: [], validations: {} };

function calculateMealTime(heureDebut, formule) {
    const [h, m] = heureDebut.split(':').map(Number);
    let addHours = (formule === 'Classique') ? 1 : 2;
    let newH = h + addHours;
    if (newH >= 24) newH -= 24;
    return `${String(newH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function calculatePizzas(nbEnfants) {
    const n = Math.max(nbEnfants, 10);
    return 4 + Math.ceil((n - 10) / 2);
}

function calculateChips(nbEnfants) {
    if (nbEnfants >= 20) return 4;
    if (nbEnfants >= 15) return 3;
    return 2;
}

function recalculateQuantities(reservation) {
    const includesPizzas = (reservation.formule === 'Morning/Night' || reservation.formule === 'VIP');
    reservation.pizzas = includesPizzas ? calculatePizzas(reservation.nbEnfants) : 0;
    reservation.pizzas += reservation.pizzasExtra || 0;
    reservation.chips = calculateChips(reservation.nbEnfants);
    reservation.boissons = calculateChips(reservation.nbEnfants);
    if (reservation.pochettes > 0) {
        reservation.pochettes = reservation.nbEnfants;
    }
    return reservation;
}

function parseReservations(text) {
    const reservations = [];
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const slotPattern = /(\d{1,2}:\d{2})\s*[→→-]\s*(\d{1,2}:\d{2})/g;
    const slots = [];
    let match;
    while ((match = slotPattern.exec(text)) !== null) {
        slots.push({ start: match[1], end: match[2], index: match.index });
    }
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const nextSlotIndex = slots[i + 1] ? slots[i + 1].index : text.length;
        const slotContent = text.substring(slot.index, nextSlotIndex);
        if (!/Jump\s*Anniv|Formule/i.test(slotContent)) continue;
        const formuleMatches = [...slotContent.matchAll(/(\d{1,2})\.00\s*Formule\s*(Anniversaire\s*VIP|Morning|Night|Classique)/gi)];
        const childMatches = [...slotContent.matchAll(/([A-Za-zÀ-ÿ\-]+)\s+([A-Za-zÀ-ÿ\-]+)\s*\([MF]\)[^)]*?(\d{1,2})\s*ans/gi)];
        for (let j = 0; j < Math.max(formuleMatches.length, childMatches.length); j++) {
            const formuleMatch = formuleMatches[j];
            const childMatch = childMatches[j];
            if (!formuleMatch) continue;
            const nbEnfants = parseInt(formuleMatch[1]) || 10;
            let formuleType = formuleMatch[2].toLowerCase();
            let formula = 'Classique';
            if (formuleType.includes('vip')) formula = 'VIP';
            else if (formuleType.includes('morning') || formuleType.includes('night')) formula = 'Morning/Night';
            let childName = childMatch ? `${childMatch[1]} ${childMatch[2]}` : 'Enfant';
            let childAge = childMatch ? parseInt(childMatch[3]) : 0;
            const contextStart = Math.max(0, formuleMatch.index - 100);
            const contextEnd = Math.min(slotContent.length, formuleMatch.index + 500);
            const context = slotContent.substring(contextStart, contextEnd);
            let gateauType = '';
            if (/Moelleux.*chocolat/i.test(context)) gateauType = 'Moelleux Chocolat';
            else if (/Bavarois.*Framboise/i.test(context)) gateauType = 'Bavarois Framboise';
            else if (/Tarte.*pommes/i.test(context)) gateauType = 'Tarte Pommes';
            const hasPochettes = /Pochettes?\s*surprises?/i.test(context);
            const hasReine = /Reine/i.test(context);
            const hasMarguerite = /Marguerite/i.test(context);
            const hasChampagne = /Champagne/i.test(context);
            const includesPizzas = (formula === 'Morning/Night' || formula === 'VIP');
            reservations.push({
                id: `res_${Date.now()}_${reservations.length}_${Math.random().toString(36).substr(2, 5)}`,
                heureDebut: slot.start,
                heureRepas: calculateMealTime(slot.start, formula),
                enfant: childName,
                age: childAge,
                nbEnfants: nbEnfants,
                formule: formula,
                gateauType: gateauType,
                pizzas: includesPizzas ? calculatePizzas(nbEnfants) : 0,
                pizzasExtra: 0,
                chips: calculateChips(nbEnfants),
                boissons: calculateChips(nbEnfants),
                pochettes: hasPochettes ? nbEnfants : 0,
                reine: hasReine ? 1 : 0,
                marguerite: hasMarguerite ? 1 : 0,
                champagne: hasChampagne ? 1 : 0,
                optionTexte: '',
                done: false
            });
        }
    }
    const seen = new Set();
    const unique = reservations.filter(r => {
        const key = `${r.heureDebut}-${r.enfant}-${r.nbEnfants}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    unique.sort((a, b) => a.heureRepas.localeCompare(b.heureRepas));
    return unique;
}

const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cuisine.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/upload', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
        const data = await pdfParse(req.file.buffer);
        DB.reservations = parseReservations(data.text);
        DB.validations = {};
        res.json({ success: true, count: DB.reservations.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/reservations', (req, res) => res.json(DB));
app.get('/api/kitchen', (req, res) => {
    const active = DB.reservations.filter(r => !r.done).sort((a, b) => a.heureRepas.localeCompare(b.heureRepas)).slice(0, 10);
    res.json({ reservations: active, validations: DB.validations });
});

app.post('/api/reservation/:id', (req, res) => {
    const index = DB.reservations.findIndex(r => r.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Non trouvé' });
    Object.assign(DB.reservations[index], req.body);
    if (req.body.nbEnfants !== undefined || req.body.pizzasExtra !== undefined) {
        recalculateQuantities(DB.reservations[index]);
    }
    res.json({ success: true, reservation: DB.reservations[index] });
});

app.post('/api/reservation/:id/done', (req, res) => {
    const index = DB.reservations.findIndex(r => r.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Non trouvé' });
    DB.reservations[index].done = true;
    res.json({ success: true });
});

app.post('/api/validate', (req, res) => {
    const { reservationId, type } = req.body;
    if (!DB.validations[reservationId]) DB.validations[reservationId] = {};
    DB.validations[reservationId][type] = true;
    res.json({ success: true });
});

app.post('/api/unvalidate', (req, res) => {
    const { reservationId, type } = req.body;
    if (DB.validations[reservationId]) delete DB.validations[reservationId][type];
    res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
    DB = { reservations: [], validations: {} };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
