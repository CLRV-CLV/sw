import { roster } from "./roster.mjs";
const normalize = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_\s·・.'’"“”\-]+/g, "");
const aliases = new Map();
for (const r of roster)
  for (const s of [r.name, r.wiki, r.id])
    aliases.set(normalize(s), normalize(r.wiki));
for (const [a, b] of [
  ["Ellen", "Ellen Joe"],
  ["艾莲", "Ellen Joe"],
  ["妮可", "Nicole Demara"],
  ["安比", "Anby Demara"],
  ["Vivian", "Vivian Banshee"],
  ["Luciana de Montefio", "Lucy"],
  ["Nekomata", "Nekomiya Mana"],
  ["Rina", "Alexandrina Sebastiane"],
])
  aliases.set(normalize(a), normalize(b));
export function wikiIdentity(value) {
  let s = String(value || "");
  try {
    if (/^https?:/.test(s)) {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname.split("/wiki/")[1] || "");
    }
  } catch {}
  s = s
    .replace(/^(?:en|zh|zh-cn|zh-tw|ja|ko|ru|fr|de):/i, "")
    .replace(
      /\s*\((?:english|chinese|japanese|korean|简体中文|繁體中文|中文|日文|英文)\)$/i,
      "",
    );
  const n = normalize(s);
  return aliases.get(n) || n;
}
