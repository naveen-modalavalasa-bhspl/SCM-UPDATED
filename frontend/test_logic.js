const available = Array.from({length: 100}, (_, i) => `IMEI${i}`);
const initial = null;
const picking = true;
const serials = picking && initial == null ? available ?? [] : initial ?? [];
const selected = new Set(serials);

let accepted = 0;
let rejected = 0;

for (const s of available) {
    const isSelected = selected.has(s);
    const isRejected = !isSelected;
    if (isSelected) accepted++;
    else rejected++;
}

console.log(`${accepted} accepted, ${rejected} rejected`);
