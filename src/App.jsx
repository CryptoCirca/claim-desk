import { useState, useEffect, useRef, useCallback } from "react";

/* ============================================================
   CLAIM DESK — Product Claim System (V1 prototype)
   - Customer registration + admin approval
   - Claim events with coded product lists + image
   - Stock-aware claiming, waitlist, deposit tracking
   - Manual payment confirmation with unique payment refs
   - Full audit log, filters, CSV export
   Data persists via window.storage (shared scope) so the
   admin view and customer views see the same live data.
   ============================================================ */

/* ---------- design tokens ---------- */
const C = {
  bg: "#F1EFE9",
  ink: "#22271F",
  sub: "#6E7268",
  line: "#DCD8CB",
  card: "#FFFFFF",
  teal: "var(--accent, #136A57)",
  tealSoft: "var(--accent-soft, #E2EFEA)",
  amber: "#9A6A00",
  amberSoft: "#F7EDD3",
  red: "#A83A2C",
  redSoft: "#F7E5E1",
  slate: "#3D5568",
  slateSoft: "#E5ECF1",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

const STATUS_META = {
  awaiting_deposit: { label: "Awaiting deposit", bg: C.amberSoft, fg: C.amber },
  deposit_received: { label: "Deposit received", bg: C.slateSoft, fg: C.slate },
  confirmed: { label: "Confirmed", bg: C.tealSoft, fg: C.teal },
  waitlisted: { label: "Waitlisted", bg: "#EEE9F7", fg: "#5B4A8A" },
  ready: { label: "Ready for collection", bg: C.tealSoft, fg: C.teal },
  collected: { label: "Collected", bg: "#E8E8E4", fg: "#565A52" },
  cancelled: { label: "Cancelled", bg: C.redSoft, fg: C.red },
  expired: { label: "Expired", bg: C.redSoft, fg: C.red },
};
const PAY_META = {
  awaiting: { label: "Awaiting payment", fg: C.amber },
  received: { label: "Payment received", fg: C.teal },
  overdue: { label: "Payment overdue", fg: C.red },
  refunded: { label: "Refunded", fg: C.slate },
  forfeited: { label: "Deposit forfeited", fg: C.red },
  cancelled: { label: "Cancelled", fg: C.sub },
};
const HOLDS_STOCK = ["awaiting_deposit", "deposit_received", "confirmed", "ready", "collected"];
// statuses that count toward per-customer claim limits (waitlist spots count too,
// so limits can't be gamed by joining the waitlist)
const COUNTS_FOR_LIMITS = [...HOLDS_STOCK, "waitlisted"];

/* ---------- storage helpers ---------- */
const K = { users: "pcs:users", events: "pcs:events", claims: "pcs:claims", audit: "pcs:audit", settings: "pcs:settings" };

const STAFF_ROLES = { superadmin: "Super Admin", claimadmin: "Claim Administrator" };
const isStaffRole = (r) => r === "superadmin" || r === "claimadmin" || r === "admin";

const defaultSettings = () => ({
  storeName: "Claim Desk",
  logo: null,
  accentColor: "#136A57",
  headerColor: "#22271F",
  paymentInstructions: "Bank transfer — BSB 000-000, Account 1234 5678, Name: Your Store. Use your claim reference as the transfer description, or pay in store.",
  defaultDeposit: 10,
  defaultPaymentHours: 24,
  emailFromName: "Your Store",
  emailFrom: "claims@yourstore.com",
  emailReplyTo: "hello@yourstore.com",
  delivery: { method: "smtp", smtpHost: "", smtpPort: "587", smtpEncryption: "TLS (STARTTLS)", smtpUser: "", smtpPass: "", apiProvider: "Resend", apiKey: "" },
  notif: { approved: true, newEvent: true, claimed: true, depositReceived: true, ready: true, cancelled: true },
});

// ---------------------------------------------------------------
// SHARED DATABASE (optional but recommended for team review)
// Fill in these two values from your Supabase project
// (Settings → API): everyone who opens the site then shares the
// same live data. Leave blank to fall back to per-browser storage.
// The anon key is designed to be public — it is safe in this file.
// ---------------------------------------------------------------
const REMOTE = {
  url: "https://rvznbawvyugjqbtocaph.supabase.co",     // e.g. "https://abcd1234.supabase.co"
  anonKey: "sb_publishable_7PwblJf2CtYAQpSP4wl1mw_PZ9sVIIn", // the long "anon public" key
};

// Show the demo sign-in hints on the login screen (set true for internal testing)
const SHOW_DEMO_LOGINS = false;

const hasRemote = () => REMOTE.url && REMOTE.anonKey;
const remoteHeaders = () => ({
  apikey: REMOTE.anonKey,
  Authorization: `Bearer ${REMOTE.anonKey}`,
  "Content-Type": "application/json",
});
async function remoteGet(key) {
  const res = await fetch(`${REMOTE.url}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers: remoteHeaders() });
  if (!res.ok) throw new Error("remote get failed");
  const rows = await res.json();
  return rows.length ? rows[0].value : null;
}
async function remoteSet(key, value) {
  const res = await fetch(`${REMOTE.url}/rest/v1/kv`, {
    method: "POST",
    headers: { ...remoteHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value }]),
  });
  if (!res.ok) throw new Error("remote set failed");
}

// Storage adapter — works in these environments, in order of preference:
// 1. Claude artifact storage (window.storage) when running inside claude.ai
// 2. Shared database (Supabase) when REMOTE is configured — for shared keys
// 3. Browser localStorage when deployed standalone (per-reviewer data)
// 4. In-memory only, as a last resort (data lasts for the session)
// Private keys (shared = false, e.g. your sign-in session) never leave
// this browser.
const mem = {};
const hasStorage = () =>
  typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";
const hasLocal = () => {
  try { return typeof window !== "undefined" && !!window.localStorage; } catch { return false; }
};

async function loadKey(key, fallback, shared = true) {
  const fromMem = () => (key in mem ? JSON.parse(mem[key]) : fallback);
  if (hasStorage()) {
    try {
      const r = await window.storage.get(key, shared);
      if (r && r.value) { mem[key] = r.value; return JSON.parse(r.value); }
      return fromMem();
    } catch { /* fall through */ }
  }
  if (shared && hasRemote()) {
    try {
      const v = await remoteGet(key);
      if (v !== null) { mem[key] = v; return JSON.parse(v); }
      return fallback; // remote is the source of truth for shared data
    } catch { /* fall through to localStorage */ }
  }
  if (hasLocal()) {
    try {
      const v = window.localStorage.getItem(key);
      if (v) { mem[key] = v; return JSON.parse(v); }
    } catch { /* fall through to memory */ }
  }
  return fromMem();
}
async function saveKey(key, val, shared = true) {
  mem[key] = JSON.stringify(val);
  if (hasStorage()) {
    try { await window.storage.set(key, mem[key], shared); } catch (e) { console.error("storage save failed", e); }
  }
  if (shared && hasRemote()) {
    try { await remoteSet(key, mem[key]); } catch (e) { console.error("shared database save failed", e); }
  }
  if (hasLocal()) {
    try { window.localStorage.setItem(key, mem[key]); } catch { /* quota or privacy mode */ }
  }
  return true;
}

/* ---------- small utils ---------- */
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const money = (n) => "$" + Number(n || 0).toFixed(2).replace(/\.00$/, "");
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const payRef = (code) => `CLM-${code}-${uid().slice(0, 4)}`;
const nowISO = () => new Date().toISOString();

/* ---------- theme helpers ---------- */
function softColor(hex) {
  const m = /^#?([\da-fA-F]{6})$/.exec(hex || "");
  if (!m) return "#E2EFEA";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.14)`;
}
function isLightColor(hex) {
  const m = /^#?([\da-fA-F]{6})$/.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
}
const THEME_PRESETS = [
  { name: "Forest", accent: "#136A57", header: "#22271F" },
  { name: "Ruby", accent: "#B3372E", header: "#2B1A18" },
  { name: "Ocean", accent: "#1D5FA8", header: "#152436" },
  { name: "Violet", accent: "#6A4FB6", header: "#241D33" },
  { name: "Amber", accent: "#9A6A00", header: "#2A2214" },
  { name: "Noir", accent: "#4A524C", header: "#101210" },
];

function timeLeft(iso) {
  if (!iso) return "";
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return "overdue";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
const isOpen = (ev) => {
  const n = Date.now();
  return ev.published && new Date(ev.opensAt) <= n && n < new Date(ev.closesAt);
};

/* ---------- public event URLs (#/event/<id>) ---------- */
const getRoute = () => {
  const m = (typeof window !== "undefined" ? window.location.hash : "").match(/^#\/event\/([\w-]+)/);
  return m ? { eventId: m[1] } : null;
};
const eventShareUrl = (ev) =>
  `${window.location.origin}${window.location.pathname}#/event/${ev.id}`;

// human countdown, e.g. "2d 4h", "3h 12m", "9m 40s"
function countdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3),
    m = Math.floor((ms % 3600e3) / 60000), s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}
const heldQty = (claims, eventId, code) =>
  claims
    .filter((c) => c.eventId === eventId && c.code === code && HOLDS_STOCK.includes(c.status))
    .reduce((s, c) => s + c.qty, 0);

/* ---------- customer reliability ---------- */
const CUSTOMER_GROUPS = { standard: "Standard", vip: "VIP", staff: "Staff" };

function scoreStats(userId, claims) {
  const mine = claims.filter((c) => c.userId === userId);
  return {
    collected: mine.filter((c) => c.status === "collected").length,
    cancelled: mine.filter((c) => c.status === "cancelled" && c.cancelledBy === "customer").length,
    expired: mine.filter((c) => c.status === "expired").length,
    noShows: mine.filter((c) => c.noShow).length,
    late: mine.filter((c) => c.paidLate).length,
  };
}
function scoreFor(user, claims) {
  const s = scoreStats(user.id, claims);
  const raw = 100 + 2 * s.collected - 5 * s.cancelled - 10 * s.expired - 15 * s.noShows - 3 * s.late + (+user.scoreAdj || 0);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/* ---------- allocation rules ---------- */
const defaultRules = () => ({
  maxItemsPerCustomer: 0, // 0 = no limit (whole event)
  minScore: 0,            // 0 = off
  minAccountDays: 0,      // 0 = off
  earlyAccess: { enabled: false, minutes: 30, groups: ["vip", "staff"] },
});

// Checks whether a customer may claim this product right now.
// Returns { ok: true, maxQty } or { ok: false, msg }.
function claimEligibility(user, ev, product, claims) {
  const rules = { ...defaultRules(), ...(ev.rules || {}) };
  const group = user.group || "standard";
  if (rules.earlyAccess && rules.earlyAccess.enabled) {
    const end = new Date(ev.opensAt).getTime() + (+rules.earlyAccess.minutes || 0) * 60000;
    if (Date.now() < end && !(rules.earlyAccess.groups || []).includes(group))
      return { ok: false, msg: `Early access until ${fmtDT(new Date(end).toISOString())} — opens to everyone after that` };
  }
  if ((+rules.minAccountDays || 0) > 0 && user.createdAt) {
    const days = (Date.now() - new Date(user.createdAt)) / 86400e3;
    if (days < +rules.minAccountDays)
      return { ok: false, msg: `Available to accounts at least ${rules.minAccountDays} days old` };
  }
  if ((+rules.minScore || 0) > 0 && scoreFor(user, claims) < +rules.minScore)
    return { ok: false, msg: "This event has claim requirements your account does not currently meet — contact the store if unsure" };
  const mine = claims.filter((c) => c.eventId === ev.id && c.userId === user.id && COUNTS_FOR_LIMITS.includes(c.status));
  const myTotal = mine.reduce((s, c) => s + c.qty, 0);
  const evMax = +rules.maxItemsPerCustomer || 0;
  if (evMax > 0 && myTotal >= evMax)
    return { ok: false, msg: `Limit of ${evMax} item${evMax > 1 ? "s" : ""} per customer for this event` };
  const myProd = mine.filter((c) => c.code === product.code).reduce((s, c) => s + c.qty, 0);
  const pMax = +product.maxPerCustomer || 0;
  if (pMax > 0 && myProd >= pMax) return { ok: false, msg: `Limit ${pMax} per customer` };
  const excl = (product.excludeIfClaimed || "").trim().toUpperCase();
  if (excl && mine.some((c) => c.code === excl))
    return { ok: false, msg: `Not available if you have claimed ${excl}` };
  const maxQty = Math.min(evMax > 0 ? evMax - myTotal : Infinity, pMax > 0 ? pMax - myProd : Infinity);
  return { ok: true, maxQty };
}

/* ---------- waitlist ordering ---------- */
const byWaitlistOrder = (a, b) => (a.waitlistOrder || a.claimedAt).localeCompare(b.waitlistOrder || b.claimedAt);
const waitlistQueue = (claims, eventId, code) =>
  claims.filter((c) => c.eventId === eventId && c.code === code && c.status === "waitlisted").sort(byWaitlistOrder);
function waitlistPosition(claim, claims) {
  const q = waitlistQueue(claims, claim.eventId, claim.code);
  return { pos: q.findIndex((c) => c.id === claim.id) + 1, total: q.length };
}

/* ---------- automatic expiry & promotion sweep ----------
   Runs on every data refresh. Expires unpaid reservations past their
   deadline (per event setting), returns the stock, and promotes the
   waitlist in strict first-come-first-served order (per event setting). */
function runMaintenance(events, claims) {
  const out = claims.map((c) => ({ ...c }));
  const audits = [];
  let changed = false;
  const evById = Object.fromEntries(events.map((e) => [e.id, e]));

  for (const c of out) {
    const ev = evById[c.eventId];
    if (!ev || !ev.autoExpire) continue;
    if (c.status === "awaiting_deposit" && c.paymentStatus === "awaiting" && c.deadline && new Date(c.deadline) < Date.now()) {
      c.status = "expired"; c.paymentStatus = "overdue"; changed = true;
      audits.push({ ts: nowISO(), actor: "System", action: "Reservation auto-expired", detail: `${c.code} ×${c.qty} — ${c.customer} (${c.ref})` });
    }
  }
  for (const ev of events) {
    if (!ev.autoPromote) continue;
    for (const p of ev.products || []) {
      let held = out.filter((c) => c.eventId === ev.id && c.code === p.code && HOLDS_STOCK.includes(c.status)).reduce((s, c) => s + c.qty, 0);
      const queue = out.filter((c) => c.eventId === ev.id && c.code === p.code && c.status === "waitlisted").sort(byWaitlistOrder);
      for (const w of queue) {
        if (held + w.qty > p.qty) break; // strict first-come-first-served: never jump the queue
        w.status = "awaiting_deposit";
        w.deadline = new Date(Date.now() + (ev.paymentHours || 24) * 3600e3).toISOString();
        w.promoted = true; w.promotedAt = nowISO();
        held += w.qty; changed = true;
        audits.push({ ts: nowISO(), actor: "System", action: "Auto-promoted from waitlist", detail: `${w.code} ×${w.qty} — ${w.customer} (${w.ref})` });
      }
    }
  }
  return { claims: out, audits, changed };
}

/* ---------- seed data ---------- */
const seedImage = () => {
  const cells = [
    ["A1", 60, 60], ["A2", 220, 60], ["A3", 380, 60],
    ["B1", 60, 200], ["B2", 220, 200], ["B3", 380, 200],
  ];
  const rects = cells
    .map(
      ([c, x, y]) =>
        `<rect x="${x}" y="${y}" width="140" height="110" rx="10" fill="#E7E3D6" stroke="#C9C4B2"/>` +
        `<rect x="${x + 8}" y="${y + 8}" width="34" height="20" rx="4" fill="#22271F"/>` +
        `<text x="${x + 25}" y="${y + 22}" font-family="monospace" font-size="12" fill="#F1EFE9" text-anchor="middle">${c}</text>` +
        `<text x="${x + 70}" y="${y + 70}" font-family="sans-serif" font-size="12" fill="#6E7268" text-anchor="middle">product photo</text>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="580" height="370" viewBox="0 0 580 370"><rect width="580" height="370" fill="#F7F5EF"/><text x="24" y="34" font-family="sans-serif" font-size="14" fill="#22271F" font-weight="bold">SATURDAY DROP — group photo with claim codes</text>${rects}</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
};

function seedData() {
  const t = Date.now();
  const users = [
    { id: "admin", role: "superadmin", name: "Store Admin", email: "admin", mobile: "", pay: "", notes: "", pin: "1234", status: "approved", group: "staff", createdAt: nowISO() },
    { id: "u-demo", role: "customer", name: "Sam Lee", email: "sam@example.com", mobile: "0400 000 111", pay: "Bank transfer", notes: "", pin: "1111", status: "pending", group: "standard", createdAt: nowISO() },
  ];
  const events = [
    {
      id: "ev-demo",
      title: "Saturday Drop #14",
      description: "First in, first served. Claim your codes from the photo, then transfer your deposit within the payment window to lock it in. Limit 3 items per customer; booster boxes limited to 1 each.",
      image: seedImage(),
      products: [
        { code: "A1", name: "Scarlet & Violet Booster Box (sealed)", price: 250, deposit: 20, qty: 2, maxPerCustomer: 1, excludeIfClaimed: "" },
        { code: "A2", name: "Elite Trainer Box", price: 85, deposit: 10, qty: 4, maxPerCustomer: 2, excludeIfClaimed: "" },
        { code: "A3", name: "Ultra Premium Collection", price: 180, deposit: 20, qty: 1, maxPerCustomer: 1, excludeIfClaimed: "A1" },
        { code: "B1", name: "One Piece OP-09 Booster Box", price: 140, deposit: 15, qty: 3, maxPerCustomer: 1, excludeIfClaimed: "" },
        { code: "B2", name: "Lorcana Illumineer's Trove", price: 75, deposit: 10, qty: 2, maxPerCustomer: 1, excludeIfClaimed: "" },
        { code: "B3", name: "MTG Play Booster Box", price: 160, deposit: 15, qty: 2, maxPerCustomer: 1, excludeIfClaimed: "" },
      ],
      opensAt: new Date(t - 3600e3).toISOString(),
      closesAt: new Date(t + 48 * 3600e3).toISOString(),
      paymentHours: 24,
      waitlist: true,
      autoExpire: true,
      autoPromote: true,
      rules: { ...defaultRules(), maxItemsPerCustomer: 3 },
      published: true,
      createdAt: nowISO(),
    },
  ];
  return { users, events, claims: [], audit: [{ ts: nowISO(), actor: "System", action: "Setup", detail: "Demo data created" }] };
}

/* ---------- shared UI atoms ---------- */
function Tag({ code, dark = true, size = "md" }) {
  const pad = size === "sm" ? "1px 8px 1px 14px" : "3px 12px 3px 18px";
  return (
    <span
      style={{
        fontFamily: C.mono, fontWeight: 700, letterSpacing: "0.5px",
        background: dark ? C.ink : C.card, color: dark ? "#F1EFE9" : C.ink,
        border: dark ? "none" : `1.5px solid ${C.ink}`,
        borderRadius: 6, padding: pad, position: "relative", display: "inline-block",
        fontSize: size === "sm" ? 12 : 14,
      }}
    >
      <span style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", width: 5, height: 5, borderRadius: "50%", background: dark ? "#F1EFE9" : C.ink, opacity: 0.85 }} />
      {code}
    </span>
  );
}
function Chip({ s }) {
  const m = STATUS_META[s] || { label: s, bg: "#EEE", fg: "#555" };
  return <span style={{ background: m.bg, color: m.fg, fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 99, whiteSpace: "nowrap" }}>{m.label}</span>;
}
function PayChip({ p }) {
  const m = PAY_META[p] || { label: p, fg: "#555" };
  return <span style={{ color: m.fg, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{m.label}</span>;
}
function Btn({ children, onClick, kind = "primary", small, disabled, style }) {
  const base = {
    primary: { background: C.ink, color: "#F1EFE9", border: "none" },
    teal: { background: C.teal, color: "#fff", border: "none" },
    ghost: { background: "transparent", color: C.ink, border: `1.5px solid ${C.line}` },
    danger: { background: "transparent", color: C.red, border: `1.5px solid ${C.redSoft}` },
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...base, borderRadius: 8, cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1, fontWeight: 600,
        fontSize: small ? 12 : 14, padding: small ? "5px 10px" : "9px 16px", ...style,
      }}
    >
      {children}
    </button>
  );
}
function Field({ label, children, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: C.sub, marginTop: 3 }}>{hint}</div>}
    </label>
  );
}
const inputStyle = {
  width: "100%", padding: "9px 11px", borderRadius: 8, border: `1.5px solid ${C.line}`,
  background: "#fff", fontSize: 14, color: C.ink, outline: "none", boxSizing: "border-box",
};
function Card({ children, style }) {
  return <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, ...style }}>{children}</div>;
}
function Empty({ children }) {
  return <div style={{ padding: "36px 16px", textAlign: "center", color: C.sub, fontSize: 14 }}>{children}</div>;
}

/* ============================================================
   ROOT APP
   ============================================================ */
export default function App() {
  const [users, setUsers] = useState([]);
  const [events, setEvents] = useState([]);
  const [claims, setClaims] = useState([]);
  const [audit, setAudit] = useState([]);
  const [settings, setSettings] = useState(defaultSettings());
  const [session, setSession] = useState(null);
  const [route, setRoute] = useState(getRoute());
  const [wantAuth, setWantAuth] = useState(false);
  useEffect(() => {
    const onHash = () => { setRoute(getRoute()); setWantAuth(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const notify = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const reloadAll = useCallback(async () => {
    const [u, e, c, a, s] = await Promise.all([
      loadKey(K.users, null), loadKey(K.events, null), loadKey(K.claims, null), loadKey(K.audit, null), loadKey(K.settings, null),
    ]);
    setSettings(s ? { ...defaultSettings(), ...s, notif: { ...defaultSettings().notif, ...(s.notif || {}) }, delivery: { ...defaultSettings().delivery, ...(s.delivery || {}) } } : defaultSettings());
    if (u === null || !Array.isArray(u) || u.length === 0) {
      const seed = seedData();
      await Promise.all([saveKey(K.users, seed.users), saveKey(K.events, seed.events), saveKey(K.claims, seed.claims), saveKey(K.audit, seed.audit)]);
      setUsers(seed.users); setEvents(e && e.length ? e : seed.events); setClaims(c || seed.claims); setAudit(a || seed.audit);
    } else {
      // safety nets: the Super Admin must always exist; migrate legacy "admin" role
      let usersList = u.map((x) => (x.role === "admin" ? { ...x, role: "superadmin" } : x));
      if (!usersList.some((x) => x.id === "admin")) usersList = [seedData().users[0], ...usersList];
      if (JSON.stringify(usersList) !== JSON.stringify(u)) await saveKey(K.users, usersList);
      setUsers(usersList); setEvents(e || []);

      // automatic reservation expiry + waitlist promotion
      const maint = runMaintenance(e || [], c || []);
      if (maint.changed) {
        const nextAudit = [...maint.audits, ...(a || [])].slice(0, 500);
        await saveKey(K.claims, maint.claims);
        await saveKey(K.audit, nextAudit);
        setClaims(maint.claims); setAudit(nextAudit);
      } else {
        setClaims(c || []); setAudit(a || []);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      await reloadAll();
      const s = await loadKey("pcs:session", null, false);
      setSession(s);
      setLoading(false);
    })();
  }, [reloadAll]);

  // light polling so admin/customer views stay in sync
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) reloadAll(); }, 12000);
    return () => clearInterval(t);
  }, [reloadAll]);

  /* --- mutation helpers: always re-read fresh before writing --- */
  const mutate = useCallback(async (key, setter, fn) => {
    const cur = await loadKey(key, []);
    const next = fn(cur);
    if (next === undefined) return cur;
    await saveKey(key, next);
    setter(next);
    return next;
  }, []);

  const addAudit = useCallback(
    (actor, action, detail) =>
      mutate(K.audit, setAudit, (a) => [{ ts: nowISO(), actor, action, detail }, ...a].slice(0, 500)),
    [mutate]
  );

  const setSessionPersist = async (s) => {
    setSession(s);
    if (s) await saveKey("pcs:session", s, false);
    else {
      delete mem["pcs:session"];
      if (hasStorage()) { try { await window.storage.delete("pcs:session", false); } catch {} }
      if (hasLocal()) { try { window.localStorage.removeItem("pcs:session"); } catch {} }
    }
  };

  /* --- domain actions --- */
  const actions = {
    async register(form) {
      let cur = await loadKey(K.users, []);
      if (!Array.isArray(cur) || cur.length === 0) cur = users.length ? users : seedData().users;
      if (cur.some((u) => u.email.toLowerCase() === form.email.toLowerCase()))
        return { ok: false, msg: "An account with that email already exists." };
      const user = { id: "u-" + uid(), role: "customer", status: "pending", createdAt: nowISO(), ...form };
      await saveKey(K.users, [...cur, user]);
      setUsers([...cur, user]);
      await addAudit(user.name, "Registered", `${user.email} — pending approval`);
      return { ok: true, user };
    },
    async login(email, pin) {
      let cur = await loadKey(K.users, []);
      if (!Array.isArray(cur) || cur.length === 0) cur = users.length ? users : seedData().users;
      setUsers(cur);
      const u = cur.find((x) => x.email.toLowerCase() === email.trim().toLowerCase() && x.pin === pin);
      if (!u) return { ok: false, msg: "No account matches that email and PIN." };
      await setSessionPersist({ userId: u.id });
      return { ok: true };
    },
    logout: () => setSessionPersist(null),

    async setUserStatus(target, status, actorName) {
      await mutate(K.users, setUsers, (us) => us.map((u) => (u.id === target.id ? { ...u, status } : u)));
      await addAudit(actorName, "Account " + status, `${target.name} (${target.email})`);
      notify(`${target.name} — ${status}`);
    },

    async saveSettings(next, actorName) {
      await saveKey(K.settings, next);
      setSettings(next);
      await addAudit(actorName, "Settings updated", "Store, payment, and email settings");
      notify("Settings saved");
    },
    async createStaff(form, actorName) {
      let cur = await loadKey(K.users, []);
      if (!Array.isArray(cur) || cur.length === 0) cur = users;
      if (cur.some((u) => u.email.toLowerCase() === form.email.toLowerCase()))
        return { ok: false, msg: "An account with that email already exists." };
      const user = { id: "u-" + uid(), status: "approved", createdAt: nowISO(), pay: "", notes: "", ...form };
      await saveKey(K.users, [...cur, user]);
      setUsers([...cur, user]);
      await addAudit(actorName, "Staff account created", `${user.name} — ${STAFF_ROLES[user.role] || user.role}`);
      notify("Staff account created");
      return { ok: true };
    },
    async setUserRole(target, role, actorName) {
      await mutate(K.users, setUsers, (us) => us.map((u) => (u.id === target.id ? { ...u, role } : u)));
      await addAudit(actorName, "Role changed", `${target.name} → ${STAFF_ROLES[role] || role}`);
      notify(`${target.name} is now ${STAFF_ROLES[role] || role}`);
    },

    async saveEvent(ev, actorName, isNew) {
      await mutate(K.events, setEvents, (es) => (isNew ? [ev, ...es] : es.map((e) => (e.id === ev.id ? ev : e))));
      await addAudit(actorName, isNew ? "Event created" : "Event updated", ev.title);
      notify(isNew ? "Event created" : "Event saved");
    },
    async togglePublish(ev, actorName) {
      const next = { ...ev, published: !ev.published };
      await mutate(K.events, setEvents, (es) => es.map((e) => (e.id === ev.id ? next : e)));
      await addAudit(actorName, next.published ? "Event published" : "Event unpublished", ev.title);
    },

    async placeClaim(user, ev, product, qty) {
      let result = { ok: false, msg: "Something went wrong." };
      await mutate(K.claims, setClaims, (cs) => {
        // allocation rules are checked against fresh data at the moment of claiming
        const elig = claimEligibility(user, ev, product, cs);
        if (!elig.ok) { result = { ok: false, msg: elig.msg }; return undefined; }
        if (elig.maxQty !== Infinity && qty > elig.maxQty) {
          result = { ok: false, msg: `You can claim at most ${elig.maxQty} more of this within your limits.` };
          return undefined;
        }
        const avail = product.qty - heldQty(cs, ev.id, product.code);
        const base = {
          id: "c-" + uid(), eventId: ev.id, eventTitle: ev.title, userId: user.id,
          customer: user.name, email: user.email, mobile: user.mobile,
          code: product.code, product: product.name, price: product.price,
          qty, depositEach: product.deposit, depositTotal: product.deposit * qty,
          ref: payRef(product.code), claimedAt: nowISO(),
        };
        if (avail >= qty) {
          const claim = {
            ...base, status: "awaiting_deposit", paymentStatus: "awaiting",
            deadline: new Date(Date.now() + (ev.paymentHours || 24) * 3600e3).toISOString(),
          };
          result = { ok: true, claim };
          return [claim, ...cs];
        }
        if (ev.waitlist) {
          const claim = { ...base, status: "waitlisted", paymentStatus: "awaiting", deadline: null, waitlistOrder: nowISO() };
          result = { ok: "wait", claim };
          return [claim, ...cs];
        }
        result = { ok: false, msg: avail <= 0 ? "Sold out — all stock is claimed." : `Only ${avail} left for ${product.code}.` };
        return undefined;
      });
      if (result.claim)
        await addAudit(user.name, result.ok === "wait" ? "Joined waitlist" : "Claimed", `${result.claim.code} ×${qty} — ${ev.title} (${result.claim.ref})`);
      return result;
    },

    async updateClaim(claim, patch, actorName, auditAction) {
      await mutate(K.claims, setClaims, (cs) => cs.map((c) => (c.id === claim.id ? { ...c, ...patch } : c)));
      await addAudit(actorName, auditAction, `${claim.code} ×${claim.qty} — ${claim.customer} (${claim.ref})`);
      notify(auditAction);
    },

    async promoteFromWaitlist(claim, ev, actorName) {
      let ok = false;
      await mutate(K.claims, setClaims, (cs) => {
        const product = ev.products.find((p) => p.code === claim.code);
        if (!product) return undefined;
        const avail = product.qty - heldQty(cs, ev.id, claim.code);
        if (avail < claim.qty) { notify(`Not enough stock free for ${claim.code} (${avail} available).`); return undefined; }
        ok = true;
        return cs.map((c) =>
          c.id === claim.id
            ? { ...c, status: "awaiting_deposit", promoted: true, promotedAt: nowISO(), deadline: new Date(Date.now() + (ev.paymentHours || 24) * 3600e3).toISOString() }
            : c
        );
      });
      if (ok) { await addAudit(actorName, "Promoted from waitlist", `${claim.code} — ${claim.customer}`); notify("Moved to confirmed queue — awaiting deposit"); }
    },

    async moveWaitlist(claim, dir, actorName) {
      let moved = false;
      await mutate(K.claims, setClaims, (cs) => {
        const q = waitlistQueue(cs, claim.eventId, claim.code);
        const i = q.findIndex((c) => c.id === claim.id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= q.length) return undefined;
        const a = q[i], b = q[j];
        const ao = a.waitlistOrder || a.claimedAt, bo = b.waitlistOrder || b.claimedAt;
        moved = true;
        return cs.map((c) => (c.id === a.id ? { ...c, waitlistOrder: bo } : c.id === b.id ? { ...c, waitlistOrder: ao } : c));
      });
      if (moved) await addAudit(actorName, "Waitlist reordered", `${claim.code} — ${claim.customer} moved ${dir < 0 ? "up" : "down"}`);
    },
    async setUserGroup(target, group, actorName) {
      await mutate(K.users, setUsers, (us) => us.map((u) => (u.id === target.id ? { ...u, group } : u)));
      await addAudit(actorName, "Customer group changed", `${target.name} → ${CUSTOMER_GROUPS[group] || group}`);
      notify(`${target.name} is now ${CUSTOMER_GROUPS[group] || group}`);
    },
    async setUserScoreAdj(target, adj, actorName) {
      await mutate(K.users, setUsers, (us) => us.map((u) => (u.id === target.id ? { ...u, scoreAdj: adj } : u)));
      await addAudit(actorName, "Reliability score adjusted", `${target.name}: manual adjustment ${adj >= 0 ? "+" : ""}${adj}`);
      notify("Score adjustment saved");
    },
    reload: reloadAll,
    notify,
  };

  if (loading)
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "grid", placeItems: "center", color: C.sub, fontFamily: "system-ui" }}>
        Loading claim desk…
      </div>
    );

  const me = session ? users.find((u) => u.id === session.userId) : null;

  const accent = settings.accentColor || "#136A57";
  const headerBg = settings.headerColor || "#22271F";
  const lightHeader = isLightColor(headerBg);

  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, -apple-system, sans-serif",
      "--accent": accent,
      "--accent-soft": softColor(accent),
      "--header": headerBg,
      "--header-text": lightHeader ? "#22271F" : "#F1EFE9",
      "--header-line": lightHeader ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.3)",
    }}>
      {toast && (
        <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#F1EFE9", padding: "10px 18px", borderRadius: 10, fontSize: 14, zIndex: 90, boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }}>
          {toast}
        </div>
      )}
      {!me ? (
        route && !wantAuth ? (
          <PublicEventPage
            ev={events.find((e) => e.id === route.eventId)}
            claims={claims}
            settings={settings}
            onAuth={() => setWantAuth(true)}
          />
        ) : (
          <AuthScreen actions={actions} settings={settings} />
        )
      ) : me.status !== "approved" ? (
        <PendingScreen me={me} actions={actions} />
      ) : isStaffRole(me.role) ? (
        <AdminApp me={me} users={users} events={events} claims={claims} audit={audit} settings={settings} actions={actions} />
      ) : (
        <CustomerApp me={me} events={events} claims={claims} settings={settings} actions={actions} initialEventId={route ? route.eventId : null} />
      )}
    </div>
  );
}

/* ============================================================
   PUBLIC EVENT LANDING PAGE (shareable, no sign-in required)
   ============================================================ */
function PublicEventPage({ ev, claims, settings, onAuth }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const visible = ev && ev.published;
  const opensIn = visible ? countdown(ev.opensAt) : null;
  const closesIn = visible ? countdown(ev.closesAt) : null;
  const live = visible && !opensIn && closesIn;

  return (
    <div>
      <Header logo={settings.logo} brand={settings.storeName} title={visible ? ev.title : "Claim event"} sub="Shared claim event" right={<Btn kind="ghost" small style={{ borderColor: "var(--header-line, rgba(255,255,255,0.3))", color: "var(--header-text, #F1EFE9)" }} onClick={onAuth}>Sign in</Btn>} />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 20 }}>
        {!visible ? (
          <Card style={{ textAlign: "center", padding: 32 }}>
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 6 }}>This event isn't available</div>
            <div style={{ color: C.sub, fontSize: 14, marginBottom: 16 }}>The link may be wrong, or the store hasn't published this drop yet.</div>
            <Btn onClick={onAuth}>Sign in</Btn>
          </Card>
        ) : (
          <>
            <Card style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}>
              {ev.image && <img src={ev.image} alt="Drop photo with claim codes" style={{ width: "100%", display: "block" }} />}
              <div style={{ padding: 16 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>{ev.title}</div>
                  {opensIn ? (
                    <span style={{ background: C.amberSoft, color: C.amber, fontWeight: 800, fontSize: 13, padding: "5px 12px", borderRadius: 99, fontFamily: C.mono }}>Opens in {opensIn}</span>
                  ) : closesIn ? (
                    <span style={{ background: C.tealSoft, color: C.teal, fontWeight: 800, fontSize: 13, padding: "5px 12px", borderRadius: 99, fontFamily: C.mono }}>● LIVE · closes in {closesIn}</span>
                  ) : (
                    <span style={{ background: C.redSoft, color: C.red, fontWeight: 800, fontSize: 13, padding: "5px 12px", borderRadius: 99 }}>Claims closed</span>
                  )}
                </div>
                <div style={{ color: C.sub, fontSize: 14, marginTop: 6 }}>{ev.description}</div>
              </div>
            </Card>

            <Card style={{ borderColor: C.teal, background: C.tealSoft, marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220, fontSize: 14 }}>
                  <b>Want to claim?</b> Sign in with your approved account — or register now, and once the store approves you, you can claim{live ? " while stock lasts" : " when it opens"}.
                </div>
                <Btn kind="teal" onClick={onAuth}>Sign in / Register</Btn>
              </div>
            </Card>

            <Card style={{ padding: 0 }}>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}`, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub }}>
                What's in this drop
              </div>
              {ev.products.map((p) => {
                const left = Math.max(0, p.qty - heldQty(claims, ev.id, p.code));
                return (
                  <div key={p.code} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <Tag code={p.code} />
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div style={{ fontSize: 13, color: C.sub }}>
                        {money(p.price)} · deposit {money(p.deposit)} each
                        {+p.maxPerCustomer > 0 && <> · limit {p.maxPerCustomer}/customer</>}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: left > 0 ? C.teal : C.red }}>
                      {left > 0 ? `${left} left` : ev.waitlist ? "Sold out · waitlist" : "Sold out"}
                    </div>
                  </div>
                );
              })}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   AUTH
   ============================================================ */
function Header({ title, sub, right, brand = "Claim Desk", logo = null }) {
  return (
    <div style={{ background: "var(--header, #22271F)", color: "var(--header-text, #F1EFE9)", padding: "18px 20px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {logo && <img src={logo} alt={brand} style={{ height: 44, maxWidth: 150, objectFit: "contain" }} />}
          <div>
            <div style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.65 }}>{brand}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
            {sub && <div style={{ fontSize: 13, opacity: 0.7, marginTop: 2 }}>{sub}</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
      </div>
    </div>
  );
}

function AuthScreen({ actions, settings }) {
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ name: "", email: "", mobile: "", pay: "Bank transfer", notes: "", pin: "", agree: false });
  const [login, setLogin] = useState({ email: "", pin: "" });
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const doLogin = async () => {
    setMsg(null);
    const r = await actions.login(login.email, login.pin);
    if (!r.ok) setMsg(r.msg);
  };
  const doRegister = async () => {
    setMsg(null);
    if (!f.name || !f.email || !f.mobile || f.pin.length < 4) return setMsg("Please fill in name, email, mobile, and choose a PIN of at least 4 digits.");
    if (!f.agree) return setMsg("You need to agree to the claim rules and deposit terms.");
    const r = await actions.register(f);
    if (!r.ok) return setMsg(r.msg);
    setMode("done");
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          {settings?.logo ? (
            <img src={settings.logo} alt={settings.storeName} style={{ height: 64, maxWidth: 220, objectFit: "contain", marginBottom: 10 }} />
          ) : (
            <div style={{ display: "inline-flex", gap: 6, marginBottom: 10 }}>
              <Tag code="A1" /> <Tag code="B4" dark={false} />
            </div>
          )}
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{settings?.storeName || "Claim Desk"}</div>
          <div style={{ color: C.sub, fontSize: 14 }}>Claim products from the drop photo. Pay your deposit. Collect in store.</div>
        </div>

        <Card style={{ padding: 22 }}>
          {mode === "done" ? (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Registration received</div>
              <div style={{ color: C.sub, fontSize: 14, marginBottom: 16 }}>
                Your account is pending approval. Once the store approves you, sign in with your email and PIN to start claiming.
              </div>
              <Btn onClick={() => setMode("login")}>Go to sign in</Btn>
            </div>
          ) : mode === "login" ? (
            <>
              <Field label="Email"><input style={inputStyle} value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} placeholder="you@example.com" /></Field>
              <Field label="PIN"><input style={inputStyle} type="password" value={login.pin} onChange={(e) => setLogin({ ...login, pin: e.target.value })} placeholder="••••" onKeyDown={(e) => e.key === "Enter" && doLogin()} /></Field>
              {msg && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{msg}</div>}
              <Btn onClick={doLogin} style={{ width: "100%" }}>Sign in</Btn>
              <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: C.sub }}>
                New customer?{" "}
                <a onClick={() => { setMode("register"); setMsg(null); }} style={{ color: C.teal, fontWeight: 600, cursor: "pointer" }}>Create an account</a>
              </div>
              {SHOW_DEMO_LOGINS && (
                <div style={{ marginTop: 16, padding: 10, background: C.bg, borderRadius: 8, fontSize: 12, color: C.sub }}>
                  <b>Demo sign-ins</b> — Admin: <span style={{ fontFamily: C.mono }}>admin / 1234</span> · Sample customer (pending): <span style={{ fontFamily: C.mono }}>sam@example.com / 1111</span>
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="Full name"><input style={inputStyle} value={f.name} onChange={set("name")} /></Field>
              <Field label="Mobile number"><input style={inputStyle} value={f.mobile} onChange={set("mobile")} /></Field>
              <Field label="Email address"><input style={inputStyle} value={f.email} onChange={set("email")} /></Field>
              <Field label="Preferred payment method">
                <select style={inputStyle} value={f.pay} onChange={set("pay")}>
                  <option>Bank transfer</option><option>In-store payment</option><option>Other (arranged with store)</option>
                </select>
              </Field>
              <Field label="Notes (optional)"><input style={inputStyle} value={f.notes} onChange={set("notes")} placeholder="Anything the store should know" /></Field>
              <Field label="Choose a PIN" hint="You'll use this with your email to sign in."><input style={inputStyle} type="password" value={f.pin} onChange={set("pin")} /></Field>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: C.sub, marginBottom: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={f.agree} onChange={(e) => setF({ ...f, agree: e.target.checked })} style={{ marginTop: 2 }} />
                I agree to the claim rules and deposit terms: deposits hold my claim, and unpaid claims expire after the payment window.
              </label>
              {msg && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{msg}</div>}
              <Btn onClick={doRegister} style={{ width: "100%" }}>Register</Btn>
              <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: C.sub }}>
                Already approved?{" "}
                <a onClick={() => { setMode("login"); setMsg(null); }} style={{ color: C.teal, fontWeight: 600, cursor: "pointer" }}>Sign in</a>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function PendingScreen({ me, actions }) {
  const m = { pending: ["Your account is pending approval", "The store reviews every registration before claims open to you. Check back soon."], rejected: ["Your registration wasn't approved", "Contact the store if you think this is a mistake."], suspended: ["Your account is suspended", "Contact the store to restore access."] }[me.status] || ["Account unavailable", ""];
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <Card style={{ maxWidth: 420, textAlign: "center", padding: 28 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{m[0]}</div>
        <div style={{ color: C.sub, fontSize: 14, marginBottom: 18 }}>{m[1]}</div>
        <Btn kind="ghost" onClick={actions.logout}>Sign out</Btn>
      </Card>
    </div>
  );
}

/* ============================================================
   CUSTOMER APP
   ============================================================ */
function CustomerApp({ me, events, claims, settings, actions, initialEventId }) {
  const [tab, setTab] = useState("events");
  const [openEvent, setOpenEvent] = useState(() =>
    initialEventId && events.some((e) => e.id === initialEventId && e.published) ? initialEventId : null
  );
  const mine = claims.filter((c) => c.userId === me.id);
  const live = events.filter(isOpen);
  const upcoming = events.filter((e) => e.published && new Date(e.opensAt) > Date.now());
  const ev = openEvent ? events.find((e) => e.id === openEvent) : null;

  return (
    <>
      <Header logo={settings.logo}
        brand={settings.storeName}
        title={`Hi, ${me.name.split(" ")[0]}`}
        sub="Approved customer"
        right={<Btn kind="ghost" small style={{ borderColor: "var(--header-line, rgba(255,255,255,0.3))", color: "var(--header-text, #F1EFE9)" }} onClick={actions.logout}>Sign out</Btn>}
      />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: 20 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {[["events", "Claim events"], ["claims", `My claims (${mine.length})`]].map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); setOpenEvent(null); }} style={{ padding: "8px 16px", borderRadius: 99, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14, background: tab === k ? C.ink : "transparent", color: tab === k ? "#F1EFE9" : C.sub }}>{l}</button>
          ))}
        </div>

        {tab === "events" && !ev && (
          <>
            {live.length === 0 && upcoming.length === 0 && <Empty>No claim events are live right now. You'll see new drops here as soon as they're published.</Empty>}
            <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
              {live.map((e) => <EventCard key={e.id} ev={e} claims={claims} onOpen={() => setOpenEvent(e.id)} live />)}
              {upcoming.map((e) => <EventCard key={e.id} ev={e} claims={claims} />)}
            </div>
          </>
        )}
        {tab === "events" && ev && <EventDetail ev={ev} me={me} claims={claims} settings={settings} actions={actions} onBack={() => setOpenEvent(null)} goClaims={() => setTab("claims")} />}
        {tab === "claims" && <MyClaims mine={mine} claims={claims} settings={settings} actions={actions} me={me} />}
      </div>
    </>
  );
}

function EventCard({ ev, claims, onOpen, live }) {
  const totalLeft = ev.products.reduce((s, p) => s + Math.max(0, p.qty - heldQty(claims, ev.id, p.code)), 0);
  return (
    <Card style={{ padding: 0, overflow: "hidden", opacity: live ? 1 : 0.75 }}>
      {ev.image && <img src={ev.image} alt="" style={{ width: "100%", height: 150, objectFit: "cover", display: "block", borderBottom: `1px solid ${C.line}` }} />}
      <div style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontWeight: 700 }}>{ev.title}</div>
          {live ? <span style={{ color: C.teal, fontSize: 12, fontWeight: 700 }}>● LIVE</span> : <span style={{ color: C.sub, fontSize: 12 }}>Opens {fmtDT(ev.opensAt)}</span>}
        </div>
        <div style={{ color: C.sub, fontSize: 13, margin: "6px 0 10px" }}>
          {ev.products.length} products · {totalLeft} items left · closes {fmtDT(ev.closesAt)}
        </div>
        {live && <Btn onClick={onOpen} style={{ width: "100%" }}>Open event</Btn>}
      </div>
    </Card>
  );
}

function EventDetail({ ev, me, claims, settings, actions, onBack, goClaims }) {
  const [sel, setSel] = useState(null); // product code being claimed
  const [qty, setQty] = useState(1);
  const [placed, setPlaced] = useState(null);
  const [err, setErr] = useState(null);

  const product = sel ? ev.products.find((p) => p.code === sel) : null;
  const avail = product ? Math.max(0, product.qty - heldQty(claims, ev.id, product.code)) : 0;

  const confirm = async () => {
    setErr(null);
    const r = await actions.placeClaim(me, ev, product, qty);
    if (r.ok) { setPlaced(r); setSel(null); await actions.reload(); }
    else setErr(r.msg);
  };

  return (
    <div>
      <a onClick={onBack} style={{ color: C.teal, fontWeight: 600, fontSize: 14, cursor: "pointer" }}>← All events</a>
      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "1fr", marginTop: 12 }}>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {ev.image && <img src={ev.image} alt="Drop photo with claim codes" style={{ width: "100%", display: "block" }} />}
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{ev.title}</div>
            <div style={{ color: C.sub, fontSize: 14, marginTop: 4 }}>{ev.description}</div>
            <div style={{ fontSize: 13, color: C.sub, marginTop: 8 }}>
              Claims close {fmtDT(ev.closesAt)} · deposit due within {ev.paymentHours}h of claiming
            </div>
          </div>
        </Card>

        {placed && (
          <Card style={{ borderColor: C.teal, background: C.tealSoft }}>
            <div style={{ fontWeight: 700, color: C.teal, marginBottom: 6 }}>
              {placed.ok === "wait" ? "You're on the waitlist" : "Claim placed — pay your deposit to lock it in"}
            </div>
            {placed.ok === true && (
              <div style={{ fontSize: 14 }}>
                Transfer <b>{money(placed.claim.depositTotal)}</b> using reference{" "}
                <span style={{ fontFamily: C.mono, fontWeight: 700, background: "#fff", padding: "2px 8px", borderRadius: 6 }}>{placed.claim.ref}</span>{" "}
                before <b>{fmtDT(placed.claim.deadline)}</b>. The store will confirm your deposit once received.
                <div style={{ fontSize: 13, color: C.sub, marginTop: 6 }}>{settings.paymentInstructions}</div>
              </div>
            )}
            {placed.ok === "wait" && <div style={{ fontSize: 14 }}>If stock frees up, the store will move you off the waitlist and you'll see deposit instructions in <b>My claims</b>.</div>}
            <div style={{ marginTop: 10 }}><Btn kind="teal" small onClick={goClaims}>View in My claims</Btn></div>
          </Card>
        )}

        <Card style={{ padding: 0 }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}`, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub }}>
            Product list — match the codes on the photo
          </div>
          {(() => {
            const r = { ...defaultRules(), ...(ev.rules || {}) };
            if (!r.earlyAccess.enabled) return null;
            const end = new Date(ev.opensAt).getTime() + (+r.earlyAccess.minutes || 0) * 60000;
            if (Date.now() >= end) return null;
            const names = (r.earlyAccess.groups || []).map((g) => CUSTOMER_GROUPS[g] || g).join(" & ");
            const isIn = (r.earlyAccess.groups || []).includes(me.group || "standard");
            return (
              <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.line}`, background: isIn ? C.tealSoft : C.amberSoft, fontSize: 13, fontWeight: 600, color: isIn ? C.teal : C.amber }}>
                {isIn ? `${names} early access is live for you now` : `${names} early access until ${fmtDT(new Date(end).toISOString())} — claiming opens to everyone after that`}
              </div>
            );
          })()}
          {ev.rules && +ev.rules.maxItemsPerCustomer > 0 && (
            <div style={{ padding: "8px 16px", borderBottom: `1px solid ${C.line}`, fontSize: 12, color: C.sub }}>
              Limit {ev.rules.maxItemsPerCustomer} item{+ev.rules.maxItemsPerCustomer > 1 ? "s" : ""} per customer across this event.
            </div>
          )}
          {ev.products.map((p) => {
            const left = Math.max(0, p.qty - heldQty(claims, ev.id, p.code));
            const wl = waitlistQueue(claims, ev.id, p.code).length;
            const elig = claimEligibility(me, ev, p, claims);
            const isSel = sel === p.code;
            return (
              <div key={p.code} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}`, background: isSel ? C.bg : "transparent" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <Tag code={p.code} />
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 13, color: C.sub }}>
                      {money(p.price)} · deposit {money(p.deposit)} each
                      {+p.maxPerCustomer > 0 && <> · limit {p.maxPerCustomer}/customer</>}
                    </div>
                    {!elig.ok && <div style={{ fontSize: 12, color: C.amber, fontWeight: 600, marginTop: 2 }}>{elig.msg}</div>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: left > 0 ? C.teal : C.red }}>
                    {left > 0 ? `${left} left` : ev.waitlist ? `Sold out · ${wl} waiting` : "Sold out"}
                  </div>
                  <Btn small kind={left > 0 ? "primary" : "ghost"} disabled={!elig.ok || (left <= 0 && !ev.waitlist)}
                    onClick={() => { setSel(isSel ? null : p.code); setQty(1); setErr(null); setPlaced(null); }}>
                    {isSel ? "Close" : left > 0 ? "Claim" : "Join waitlist"}
                  </Btn>
                </div>
                {isSel && (
                  <div style={{ marginTop: 12, padding: 12, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Btn small kind="ghost" onClick={() => setQty(Math.max(1, qty - 1))}>−</Btn>
                      <span style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 16, minWidth: 24, textAlign: "center" }}>{qty}</span>
                      <Btn small kind="ghost"
                        onClick={() => setQty(qty + 1)}
                        disabled={(avail > 0 && qty >= avail) || (elig.ok && elig.maxQty !== Infinity && qty >= elig.maxQty)}>+</Btn>
                    </div>
                    <div style={{ fontSize: 14 }}>
                      Deposit required: <b>{money(p.deposit * qty)}</b>
                      <span style={{ color: C.sub }}> ({qty} × {money(p.deposit)})</span>
                    </div>
                    <Btn kind="teal" onClick={confirm}>{avail > 0 ? "Confirm claim" : "Confirm waitlist spot"}</Btn>
                    {err && <div style={{ color: C.red, fontSize: 13, width: "100%" }}>{err}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

function MyClaims({ mine, claims, actions, me, settings }) {
  if (mine.length === 0) return <Empty>You haven't claimed anything yet. Open a live event to place your first claim.</Empty>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {mine.map((c) => {
        const overdue = c.status === "awaiting_deposit" && c.deadline && new Date(c.deadline) < Date.now();
        const wp = c.status === "waitlisted" ? waitlistPosition(c, claims) : null;
        return (
          <Card key={c.id}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <Tag code={c.code} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 700 }}>{c.product} <span style={{ color: C.sub, fontWeight: 400 }}>×{c.qty}</span></div>
                <div style={{ fontSize: 13, color: C.sub }}>{c.eventTitle} · claimed {fmtDT(c.claimedAt)}</div>
                {wp && wp.pos > 0 && (
                  <div style={{ marginTop: 8, fontSize: 14, background: "#EEE9F7", color: "#5B4A8A", padding: "8px 10px", borderRadius: 8, fontWeight: 600 }}>
                    Waitlist position #{wp.pos} of {wp.total} — you'll be moved up automatically if stock frees up.
                  </div>
                )}
                {c.promoted && c.status === "awaiting_deposit" && (
                  <div style={{ marginTop: 8, fontSize: 13, color: C.teal, fontWeight: 700 }}>
                    You've been moved off the waitlist — pay your deposit to secure it.
                  </div>
                )}
                {c.status === "awaiting_deposit" && (
                  <div style={{ marginTop: 8, fontSize: 14, background: C.amberSoft, padding: "8px 10px", borderRadius: 8 }}>
                    Pay <b>{money(c.depositTotal)}</b> with reference <span style={{ fontFamily: C.mono, fontWeight: 700 }}>{c.ref}</span> by <b>{fmtDT(c.deadline)}</b>
                    <span style={{ color: overdue ? C.red : C.amber, fontWeight: 700 }}> · {timeLeft(c.deadline)}</span>
                    <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>{settings.paymentInstructions}</div>
                  </div>
                )}
                {c.status === "ready" && <div style={{ marginTop: 8, fontSize: 14, color: C.teal, fontWeight: 600 }}>Ready — collect from the store and bring your reference {c.ref}.</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <Chip s={overdue ? "expired" : c.status} />
                <PayChip p={overdue && c.paymentStatus === "awaiting" ? "overdue" : c.paymentStatus} />
                {(c.status === "awaiting_deposit" || c.status === "waitlisted") && (
                  <Btn small kind="danger" onClick={() => actions.updateClaim(c, { status: "cancelled", paymentStatus: "cancelled", cancelledBy: "customer" }, me.name, c.status === "waitlisted" ? "Left waitlist" : "Claim cancelled by customer")}>
                    {c.status === "waitlisted" ? "Leave waitlist" : "Cancel claim"}
                  </Btn>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ============================================================
   ADMIN APP
   ============================================================ */
function AdminApp({ me, users, events, claims, audit, settings, actions }) {
  const [tab, setTab] = useState("claims");
  const isSuper = me.role === "superadmin";
  const pendingCount = users.filter((u) => u.status === "pending").length;
  const tabs = [
    ["claims", `Claims (${claims.length})`],
    ["events", `Events (${events.length})`],
    ["customers", `Customers${pendingCount ? ` · ${pendingCount} pending` : ""}`],
    ["audit", "Audit log"],
    ...(isSuper ? [["settings", "Settings & staff"]] : []),
  ];
  return (
    <>
      <Header logo={settings.logo}
        brand={settings.storeName}
        title="Admin dashboard"
        sub={`${me.name} · ${STAFF_ROLES[me.role] || "Staff"}`}
        right={
          <>
            <Btn kind="ghost" small style={{ borderColor: "var(--header-line, rgba(255,255,255,0.3))", color: "var(--header-text, #F1EFE9)" }} onClick={actions.reload}>Refresh</Btn>
            <Btn kind="ghost" small style={{ borderColor: "var(--header-line, rgba(255,255,255,0.3))", color: "var(--header-text, #F1EFE9)" }} onClick={actions.logout}>Sign out</Btn>
          </>
        }
      />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: 20 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: "8px 16px", borderRadius: 99, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14, background: tab === k ? C.ink : "transparent", color: tab === k ? "#F1EFE9" : C.sub }}>{l}</button>
          ))}
        </div>
        {tab === "claims" && <ClaimsTab claims={claims} events={events} actions={actions} me={me} />}
        {tab === "events" && <EventsTab events={events} claims={claims} actions={actions} me={me} settings={settings} />}
        {tab === "customers" && <CustomersTab users={users} claims={claims} actions={actions} me={me} />}
        {tab === "audit" && <AuditTab audit={audit} />}
        {tab === "settings" && isSuper && <SettingsTab settings={settings} users={users} actions={actions} me={me} />}
      </div>
    </>
  );
}

/* ---------- Claims tab ---------- */
function ClaimsTab({ claims, events, actions, me }) {
  const [f, setF] = useState({ event: "all", status: "all", pay: "all", q: "" });
  const filtered = claims.filter((c) => {
    if (f.event !== "all" && c.eventId !== f.event) return false;
    if (f.status !== "all" && c.status !== f.status) return false;
    if (f.pay !== "all" && c.paymentStatus !== f.pay) return false;
    if (f.q && !(c.customer + c.email + c.code + c.product + c.ref).toLowerCase().includes(f.q.toLowerCase())) return false;
    return true;
  });

  const exportCSV = () => {
    const head = ["Payment ref", "Event", "Code", "Product", "Customer", "Email", "Mobile", "Qty", "Deposit", "Status", "Payment", "Claimed at", "Payment due"];
    const rows = filtered.map((c) => [c.ref, c.eventTitle, c.code, c.product, c.customer, c.email, c.mobile, c.qty, c.depositTotal, STATUS_META[c.status]?.label || c.status, PAY_META[c.paymentStatus]?.label || c.paymentStatus, c.claimedAt, c.deadline || ""]);
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "claims-export.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const totals = {
    deposits: filtered.filter((c) => c.paymentStatus === "received").reduce((s, c) => s + c.depositTotal, 0),
    outstanding: filtered.filter((c) => c.paymentStatus === "awaiting" && HOLDS_STOCK.includes(c.status)).reduce((s, c) => s + c.depositTotal, 0),
  };

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select style={{ ...inputStyle, width: "auto" }} value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })}>
            <option value="all">All events</option>
            {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
          <select style={{ ...inputStyle, width: "auto" }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="all">All statuses</option>
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select style={{ ...inputStyle, width: "auto" }} value={f.pay} onChange={(e) => setF({ ...f, pay: e.target.value })}>
            <option value="all">All payment states</option>
            {Object.entries(PAY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <input style={{ ...inputStyle, width: 200 }} placeholder="Search customer, code, ref…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <div style={{ flex: 1 }} />
          <Btn kind="ghost" small onClick={exportCSV}>Export CSV ({filtered.length})</Btn>
        </div>
        <div style={{ marginTop: 10, fontSize: 13, color: C.sub }}>
          Deposits received: <b style={{ color: C.teal }}>{money(totals.deposits)}</b> · Outstanding: <b style={{ color: C.amber }}>{money(totals.outstanding)}</b>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Empty>No claims match these filters yet.</Empty>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map((c) => (
            <AdminClaimRow key={c.id} c={c} ev={events.find((e) => e.id === c.eventId)} claims={claims} actions={actions} me={me} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdminClaimRow({ c, ev, claims, actions, me }) {
  const overdue = c.status === "awaiting_deposit" && c.deadline && new Date(c.deadline) < Date.now();
  const wp = c.status === "waitlisted" ? waitlistPosition(c, claims) : null;
  const A = (patch, label) => () => actions.updateClaim(c, patch, me.name, label);
  return (
    <Card style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Tag code={c.code} size="sm" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            {c.customer} <span style={{ color: C.sub, fontWeight: 400 }}>· {c.product} ×{c.qty}</span>
            {wp && wp.pos > 0 && <span style={{ color: "#5B4A8A", fontWeight: 700 }}> · queue #{wp.pos} of {wp.total}</span>}
          </div>
          <div style={{ fontSize: 12, color: C.sub }}>
            {c.eventTitle} · {fmtDT(c.claimedAt)} · ref <span style={{ fontFamily: C.mono, fontWeight: 700 }}>{c.ref}</span> · deposit {money(c.depositTotal)}
            {c.deadline && c.paymentStatus === "awaiting" && <span style={{ color: overdue ? C.red : C.amber, fontWeight: 700 }}> · {timeLeft(c.deadline)}</span>}
            {c.promoted && <span style={{ color: C.teal }}> · promoted {fmtDT(c.promotedAt)}</span>}
            {c.paidLate && <span style={{ color: C.amber }}> · paid late</span>}
            {c.noShow && <span style={{ color: C.red, fontWeight: 700 }}> · no-show</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Chip s={c.status} /> <PayChip p={overdue && c.paymentStatus === "awaiting" ? "overdue" : c.paymentStatus} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {c.status === "awaiting_deposit" && (
          <Btn small kind="teal" onClick={A(
            { status: "deposit_received", paymentStatus: "received", ...(overdue ? { paidLate: true } : {}) },
            overdue ? "Deposit received (late)" : "Deposit marked received"
          )}>Mark deposit received</Btn>
        )}
        {c.status === "deposit_received" && <Btn small kind="teal" onClick={A({ status: "confirmed" }, "Claim confirmed")}>Confirm claim</Btn>}
        {c.status === "confirmed" && <Btn small kind="teal" onClick={A({ status: "ready" }, "Marked ready for collection")}>Ready for collection</Btn>}
        {c.status === "ready" && <Btn small kind="teal" onClick={A({ status: "collected" }, "Marked collected")}>Mark collected</Btn>}
        {c.status === "ready" && (
          <Btn small kind="ghost" onClick={A({ status: "cancelled", noShow: true, cancelledBy: "admin", paymentStatus: "forfeited" }, "Marked as no-show (deposit forfeited)")}>No-show</Btn>
        )}
        {c.status === "waitlisted" && ev && (
          <>
            <Btn small onClick={() => actions.promoteFromWaitlist(c, ev, me.name)}>Move off waitlist</Btn>
            <Btn small kind="ghost" disabled={!wp || wp.pos <= 1} onClick={() => actions.moveWaitlist(c, -1, me.name)}>↑ Up</Btn>
            <Btn small kind="ghost" disabled={!wp || wp.pos >= wp.total} onClick={() => actions.moveWaitlist(c, 1, me.name)}>↓ Down</Btn>
          </>
        )}
        {overdue && <Btn small kind="ghost" onClick={A({ status: "expired", paymentStatus: "overdue" }, "Claim expired (deposit not received)")}>Expire claim</Btn>}
        {!["cancelled", "expired", "collected"].includes(c.status) && (
          <Btn small kind="danger" onClick={A({ status: "cancelled", cancelledBy: "admin", paymentStatus: c.paymentStatus === "received" ? "refunded" : "cancelled" }, "Claim cancelled by admin")}>Cancel</Btn>
        )}
      </div>
    </Card>
  );
}

/* ---------- Events tab ---------- */
function EventsTab({ events, claims, actions, me, settings }) {
  const [editing, setEditing] = useState(null); // event object or "new"
  if (editing) return <EventForm initial={editing === "new" ? null : editing} onDone={() => setEditing(null)} actions={actions} me={me} settings={settings} />;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Btn onClick={() => setEditing("new")}>+ Create claim event</Btn>
      </div>
      {events.length === 0 && <Empty>No events yet. Create your first claim event to publish a drop.</Empty>}
      <div style={{ display: "grid", gap: 12 }}>
        {events.map((ev) => {
          const evClaims = claims.filter((c) => c.eventId === ev.id && HOLDS_STOCK.includes(c.status));
          const totalQty = ev.products.reduce((s, p) => s + p.qty, 0);
          const claimed = evClaims.reduce((s, c) => s + c.qty, 0);
          return (
            <Card key={ev.id}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 700 }}>
                    {ev.title}{" "}
                    <span style={{ fontSize: 12, fontWeight: 700, color: ev.published ? C.teal : C.sub }}>{ev.published ? (isOpen(ev) ? "· LIVE" : "· published") : "· draft"}</span>
                  </div>
                  <div style={{ fontSize: 13, color: C.sub }}>
                    {ev.products.length} products · {claimed}/{totalQty} items claimed · opens {fmtDT(ev.opensAt)} · closes {fmtDT(ev.closesAt)}{ev.waitlist ? " · waitlist on" : ""}
                  </div>
                </div>
                {ev.published && (
                  <Btn small kind="ghost" onClick={() => {
                    const url = eventShareUrl(ev);
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      navigator.clipboard.writeText(url).then(() => actions.notify("Share link copied — paste it into WhatsApp, Discord, or anywhere"), () => window.prompt("Copy this share link:", url));
                    } else window.prompt("Copy this share link:", url);
                  }}>Copy share link</Btn>
                )}
                <Btn small kind="ghost" onClick={() => setEditing(ev)}>Edit</Btn>
                <Btn small kind={ev.published ? "danger" : "teal"} onClick={() => actions.togglePublish(ev, me.name)}>{ev.published ? "Unpublish" : "Publish"}</Btn>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function EventForm({ initial, onDone, actions, me, settings }) {
  const toLocal = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
  const [ev, setEv] = useState(
    initial
      ? { autoExpire: false, autoPromote: false, ...initial, rules: { ...defaultRules(), ...(initial.rules || {}), earlyAccess: { ...defaultRules().earlyAccess, ...((initial.rules || {}).earlyAccess || {}) } } }
      : {
          id: "ev-" + uid(), title: "", description: "", image: null,
          products: [{ code: "A1", name: "", price: 0, deposit: settings?.defaultDeposit ?? 10, qty: 1, maxPerCustomer: 0, excludeIfClaimed: "" }],
          opensAt: nowISO(), closesAt: new Date(Date.now() + 48 * 3600e3).toISOString(),
          paymentHours: settings?.defaultPaymentHours ?? 24, waitlist: true,
          autoExpire: true, autoPromote: true, rules: defaultRules(),
          published: false, createdAt: nowISO(),
        }
  );
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  const setP = (i, k, v) => setEv({ ...ev, products: ev.products.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });
  const addP = () => setEv({ ...ev, products: [...ev.products, { code: "", name: "", price: 0, deposit: settings?.defaultDeposit ?? 10, qty: 1, maxPerCustomer: 0, excludeIfClaimed: "" }] });
  const setR = (k, v) => setEv({ ...ev, rules: { ...ev.rules, [k]: v } });
  const setEA = (k, v) => setEv({ ...ev, rules: { ...ev.rules, earlyAccess: { ...ev.rules.earlyAccess, [k]: v } } });
  const rmP = (i) => setEv({ ...ev, products: ev.products.filter((_, j) => j !== i) });

  const onFile = (file) => {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1000 / img.width);
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        const data = cv.toDataURL("image/jpeg", 0.72);
        if (data.length > 2_000_000) setMsg("That image is too large even after compression — try a smaller photo.");
        else setEv((e) => ({ ...e, image: data }));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  };

  const save = async () => {
    setMsg(null);
    if (!ev.title) return setMsg("Give the event a title.");
    const codes = ev.products.map((p) => p.code.trim().toUpperCase());
    if (codes.some((c) => !c)) return setMsg("Every product needs a claim code.");
    if (new Set(codes).size !== codes.length) return setMsg("Claim codes must be unique within the event.");
    if (ev.products.some((p) => !p.name)) return setMsg("Every product needs a name.");
    const clean = {
      ...ev,
      products: ev.products.map((p) => ({
        ...p,
        code: p.code.trim().toUpperCase(),
        price: +p.price || 0,
        deposit: +p.deposit || 0,
        qty: Math.max(1, +p.qty || 1),
        maxPerCustomer: Math.max(0, +p.maxPerCustomer || 0),
        excludeIfClaimed: (p.excludeIfClaimed || "").trim().toUpperCase(),
      })),
    };
    await actions.saveEvent(clean, me.name, !initial);
    onDone();
  };

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{initial ? "Edit claim event" : "Create claim event"}</div>
        <Btn kind="ghost" small onClick={onDone}>Back</Btn>
      </div>

      <Field label="Event title"><input style={inputStyle} value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} placeholder="Saturday Drop #15" /></Field>
      <Field label="Description"><textarea style={{ ...inputStyle, minHeight: 60 }} value={ev.description} onChange={(e) => setEv({ ...ev, description: e.target.value })} /></Field>

      <Field label="Drop photo (with claim codes visible)" hint="Photos are resized automatically. Customers match codes on the photo to the product list below.">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {ev.image && <img src={ev.image} alt="" style={{ width: 140, borderRadius: 8, border: `1px solid ${C.line}` }} />}
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => onFile(e.target.files[0])} />
          <Btn kind="ghost" small onClick={() => fileRef.current.click()}>{ev.image ? "Replace photo" : "Upload photo"}</Btn>
          {ev.image && <Btn kind="danger" small onClick={() => setEv({ ...ev, image: null })}>Remove</Btn>}
        </div>
      </Field>

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, margin: "16px 0 8px" }}>Products</div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 4, minWidth: 700, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: C.sub }}>
          <div style={{ width: 70 }}>Code</div>
          <div style={{ flex: 1 }}>Product name</div>
          <div style={{ width: 80 }}>Full price</div>
          <div style={{ width: 80 }}>Deposit / item</div>
          <div style={{ width: 60 }}>Qty avail.</div>
          <div style={{ width: 70 }}>Limit / cust.</div>
          <div style={{ width: 70 }}>Excl. code</div>
          <div style={{ width: 34 }} />
        </div>
        {ev.products.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", minWidth: 700 }}>
            <input style={{ ...inputStyle, width: 70 }} value={p.code} placeholder="A1" onChange={(e) => setP(i, "code", e.target.value)} />
            <input style={{ ...inputStyle, flex: 1 }} value={p.name} placeholder="Product name" onChange={(e) => setP(i, "name", e.target.value)} />
            <input style={{ ...inputStyle, width: 80 }} type="number" value={p.price} placeholder="Price" onChange={(e) => setP(i, "price", e.target.value)} />
            <input style={{ ...inputStyle, width: 80 }} type="number" value={p.deposit} placeholder="Deposit" onChange={(e) => setP(i, "deposit", e.target.value)} />
            <input style={{ ...inputStyle, width: 60 }} type="number" value={p.qty} placeholder="Qty" onChange={(e) => setP(i, "qty", e.target.value)} />
            <input style={{ ...inputStyle, width: 70 }} type="number" value={p.maxPerCustomer || 0} title="Max per customer (0 = no limit)" onChange={(e) => setP(i, "maxPerCustomer", e.target.value)} />
            <input style={{ ...inputStyle, width: 70 }} value={p.excludeIfClaimed || ""} placeholder="—" title="Block if customer already claimed this code" onChange={(e) => setP(i, "excludeIfClaimed", e.target.value)} />
            <Btn kind="danger" small onClick={() => rmP(i)} disabled={ev.products.length === 1}>×</Btn>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 8 }}>
        Limit / cust.: max each customer can claim of this product (0 = no limit). Excl. code: block customers who already claimed that code — e.g. put A1 on the premium box so booster-box claimers can't take both.
      </div>
      <Btn kind="ghost" small onClick={addP}>+ Add product</Btn>

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, margin: "20px 0 8px" }}>Claim rules (optional)</div>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label="Max items per customer" hint="Across the whole event. 0 = no limit.">
          <input style={inputStyle} type="number" value={ev.rules.maxItemsPerCustomer} onChange={(e) => setR("maxItemsPerCustomer", Math.max(0, +e.target.value || 0))} />
        </Field>
        <Field label="Min reliability score" hint="0 = off. Scores run 0–100; new customers start at 100.">
          <input style={inputStyle} type="number" value={ev.rules.minScore} onChange={(e) => setR("minScore", Math.max(0, Math.min(100, +e.target.value || 0)))} />
        </Field>
        <Field label="Min account age (days)" hint="0 = off. Blocks freshly made accounts.">
          <input style={inputStyle} type="number" value={ev.rules.minAccountDays} onChange={(e) => setR("minAccountDays", Math.max(0, +e.target.value || 0))} />
        </Field>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer", marginBottom: 8 }}>
        <input type="checkbox" checked={ev.rules.earlyAccess.enabled} onChange={(e) => setEA("enabled", e.target.checked)} />
        Early-access window before general claiming opens
      </label>
      {ev.rules.earlyAccess.enabled && (
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", background: C.bg, borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13 }}>
            First <input style={{ ...inputStyle, width: 70, display: "inline-block", padding: "5px 8px", margin: "0 6px" }} type="number" value={ev.rules.earlyAccess.minutes} onChange={(e) => setEA("minutes", Math.max(1, +e.target.value || 30))} /> minutes reserved for:
          </label>
          {["vip", "staff"].map((g) => (
            <label key={g} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={(ev.rules.earlyAccess.groups || []).includes(g)}
                onChange={(e) => setEA("groups", e.target.checked ? [...(ev.rules.earlyAccess.groups || []), g] : (ev.rules.earlyAccess.groups || []).filter((x) => x !== g))} />
              {CUSTOMER_GROUPS[g]}
            </label>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginTop: 18 }}>
        <Field label="Claims open"><input style={inputStyle} type="datetime-local" value={toLocal(ev.opensAt)} onChange={(e) => setEv({ ...ev, opensAt: new Date(e.target.value).toISOString() })} /></Field>
        <Field label="Claims close"><input style={inputStyle} type="datetime-local" value={toLocal(ev.closesAt)} onChange={(e) => setEv({ ...ev, closesAt: new Date(e.target.value).toISOString() })} /></Field>
        <Field label="Payment window (hours)" hint="Decimals allowed — 0.5 = 30 minutes.">
          <input style={inputStyle} type="number" step="0.5" value={ev.paymentHours} onChange={(e) => setEv({ ...ev, paymentHours: Math.max(0.25, +e.target.value || 24) })} />
        </Field>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer", marginBottom: 6 }}>
        <input type="checkbox" checked={ev.waitlist} onChange={(e) => setEv({ ...ev, waitlist: e.target.checked })} />
        Allow waitlist when a product sells out
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer", marginBottom: 6 }}>
        <input type="checkbox" checked={!!ev.autoExpire} onChange={(e) => setEv({ ...ev, autoExpire: e.target.checked })} />
        Automatically expire unpaid reservations after the payment window (stock returns to available)
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer", marginBottom: 14 }}>
        <input type="checkbox" checked={!!ev.autoPromote} onChange={(e) => setEv({ ...ev, autoPromote: e.target.checked })} />
        Automatically offer freed stock to the waitlist, first come first served
      </label>

      {msg && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={save}>{initial ? "Save changes" : "Create event"}</Btn>
        <Btn kind="ghost" onClick={onDone}>Cancel</Btn>
      </div>
    </Card>
  );
}

/* ---------- Customers tab ---------- */
function CustomersTab({ users, claims, actions, me }) {
  const customers = users.filter((u) => u.role === "customer");
  const pending = customers.filter((u) => u.status === "pending");
  const rest = customers.filter((u) => u.status !== "pending");

  const ScoreBadge = ({ u }) => {
    const sc = scoreFor(u, claims);
    const fg = sc >= 90 ? C.teal : sc >= 60 ? C.amber : C.red;
    const bg = sc >= 90 ? C.tealSoft : sc >= 60 ? C.amberSoft : C.redSoft;
    return <span title="Reliability score (admin-only)" style={{ background: bg, color: fg, fontWeight: 800, fontSize: 13, padding: "3px 10px", borderRadius: 99 }}>{sc}</span>;
  };

  const Row = ({ u }) => {
    const st = scoreStats(u.id, claims);
    const historyBits = [
      st.collected && `${st.collected} collected`,
      st.cancelled && `${st.cancelled} cancelled`,
      st.expired && `${st.expired} unpaid/expired`,
      st.noShows && `${st.noShows} no-show${st.noShows > 1 ? "s" : ""}`,
      st.late && `${st.late} late payment${st.late > 1 ? "s" : ""}`,
    ].filter(Boolean).join(" · ");
    return (
      <Card style={{ padding: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 700, display: "flex", gap: 8, alignItems: "center" }}>{u.name} <ScoreBadge u={u} /></div>
            <div style={{ fontSize: 13, color: C.sub }}>{u.email} · {u.mobile} · pays by {u.pay}{u.notes ? ` · "${u.notes}"` : ""}</div>
            <div style={{ fontSize: 12, color: C.sub }}>
              Registered {fmtDT(u.createdAt)} · {claims.filter((c) => c.userId === u.id).length} claims
              {historyBits ? ` · ${historyBits}` : " · no history yet"}
              {+u.scoreAdj ? ` · manual adjustment ${+u.scoreAdj > 0 ? "+" : ""}${u.scoreAdj}` : ""}
            </div>
          </div>
          <select
            title="Customer group — used by early-access claim rules"
            style={{ ...inputStyle, width: "auto", padding: "6px 8px" }}
            value={u.group || "standard"}
            onChange={(e) => actions.setUserGroup(u, e.target.value, me.name)}
          >
            {Object.entries(CUSTOMER_GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input
            title="Manual score adjustment (+/−), added to the calculated reliability score"
            style={{ ...inputStyle, width: 64, padding: "6px 8px" }}
            type="number"
            key={u.id + ":" + (u.scoreAdj || 0)}
            defaultValue={u.scoreAdj || 0}
            onBlur={(e) => { const v = +e.target.value || 0; if (v !== (+u.scoreAdj || 0)) actions.setUserScoreAdj(u, v, me.name); }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: { pending: C.amber, approved: C.teal, rejected: C.red, suspended: C.red }[u.status] }}>{u.status.toUpperCase()}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {u.status === "pending" && <>
              <Btn small kind="teal" onClick={() => actions.setUserStatus(u, "approved", me.name)}>Approve</Btn>
              <Btn small kind="danger" onClick={() => actions.setUserStatus(u, "rejected", me.name)}>Reject</Btn>
            </>}
            {u.status === "approved" && <Btn small kind="danger" onClick={() => actions.setUserStatus(u, "suspended", me.name)}>Suspend</Btn>}
            {(u.status === "suspended" || u.status === "rejected") && <Btn small kind="teal" onClick={() => actions.setUserStatus(u, "approved", me.name)}>Approve</Btn>}
          </div>
        </div>
      </Card>
    );
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {pending.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.amber }}>Pending approval ({pending.length})</div>
          {pending.map((u) => <Row key={u.id} u={u} />)}
        </>
      )}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, marginTop: pending.length ? 8 : 0 }}>All customers</div>
      {rest.length === 0 && pending.length === 0 ? <Empty>No customer registrations yet.</Empty> : rest.map((u) => <Row key={u.id} u={u} />)}
    </div>
  );
}

/* ---------- Settings & staff tab (Super Admin only) ---------- */
function SettingsTab({ settings, users, actions, me }) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  const setD = (k, v) => setS({ ...s, delivery: { ...s.delivery, [k]: v } });
  const setNotif = (k) => (e) => setS({ ...s, notif: { ...s.notif, [k]: e.target.checked } });

  const staff = users.filter((u) => isStaffRole(u.role));
  const [nf, setNf] = useState({ name: "", email: "", mobile: "", pin: "", role: "claimadmin" });
  const [msg, setMsg] = useState(null);

  const createStaff = async () => {
    setMsg(null);
    if (!nf.name || !nf.email || nf.pin.length < 4) return setMsg("Staff accounts need a name, email, and a PIN of at least 4 digits.");
    const r = await actions.createStaff(nf, me.name);
    if (!r.ok) return setMsg(r.msg);
    setNf({ name: "", email: "", mobile: "", pin: "", role: "claimadmin" });
  };

  const notifLabels = {
    approved: "Account approved",
    newEvent: "New claim event available",
    claimed: "Claim successful (with deposit instructions)",
    depositReceived: "Deposit received",
    ready: "Item ready for collection",
    cancelled: "Claim cancelled",
  };

  const logoRef = useRef(null);
  const onLogo = (file) => {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 160 / img.height, 500 / img.width);
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        const data = cv.toDataURL("image/png"); // PNG keeps transparency
        if (data.length > 600000) setMsg("That logo is too large — try a simpler or smaller image.");
        else setS((cur) => ({ ...cur, logo: data }));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Branding & theme</div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>
          The logo and colors apply everywhere — the sign-in page, customer dashboard, admin dashboard, and the public event pages you share on WhatsApp or Discord.
        </div>
        <Field label="Store logo" hint="PNG with a transparent background looks best. Resized automatically.">
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {s.logo && (
              <span style={{ background: s.headerColor || "#22271F", padding: "8px 14px", borderRadius: 8, display: "inline-flex" }}>
                <img src={s.logo} alt="" style={{ height: 44, maxWidth: 150, objectFit: "contain" }} />
              </span>
            )}
            <input ref={logoRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => onLogo(e.target.files[0])} />
            <Btn kind="ghost" small onClick={() => logoRef.current.click()}>{s.logo ? "Replace logo" : "Upload logo"}</Btn>
            {s.logo && <Btn kind="danger" small onClick={() => setS({ ...s, logo: null })}>Remove</Btn>}
          </div>
        </Field>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <Field label="Accent color" hint="Buttons, live badges, confirmations, links.">
            <input type="color" value={s.accentColor || "#136A57"} onChange={(e) => setS({ ...s, accentColor: e.target.value })} style={{ width: "100%", height: 40, border: `1.5px solid ${C.line}`, borderRadius: 8, background: "#fff", cursor: "pointer" }} />
          </Field>
          <Field label="Header color" hint="Top banner on every page. Text adjusts automatically for contrast.">
            <input type="color" value={s.headerColor || "#22271F"} onChange={(e) => setS({ ...s, headerColor: e.target.value })} style={{ width: "100%", height: 40, border: `1.5px solid ${C.line}`, borderRadius: 8, background: "#fff", cursor: "pointer" }} />
          </Field>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, margin: "6px 0 8px" }}>Quick themes</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {THEME_PRESETS.map((t) => (
            <button key={t.name} onClick={() => setS({ ...s, accentColor: t.accent, headerColor: t.header })}
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px", borderRadius: 99, border: `1.5px solid ${C.line}`, background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.ink }}>
              <span style={{ width: 14, height: 14, borderRadius: "50%", background: t.header, display: "inline-block" }} />
              <span style={{ width: 14, height: 14, borderRadius: "50%", background: t.accent, display: "inline-block" }} />
              {t.name}
            </button>
          ))}
        </div>
        <Btn onClick={() => actions.saveSettings(s, me.name)}>Save branding</Btn>
      </Card>

      <Card>
        <div style={{ fontWeight: 800, marginBottom: 12 }}>Store & payment settings</div>
        <Field label="Store name" hint="Shown in the header for staff and customers.">
          <input style={inputStyle} value={s.storeName} onChange={set("storeName")} />
        </Field>
        <Field label="Deposit payment instructions" hint="Shown to customers with every claim, alongside their unique payment reference.">
          <textarea style={{ ...inputStyle, minHeight: 70 }} value={s.paymentInstructions} onChange={set("paymentInstructions")} />
        </Field>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <Field label="Default deposit per item ($)">
            <input style={inputStyle} type="number" value={s.defaultDeposit} onChange={(e) => setS({ ...s, defaultDeposit: Math.max(0, +e.target.value || 0) })} />
          </Field>
          <Field label="Default payment window (hours)">
            <input style={inputStyle} type="number" value={s.defaultPaymentHours} onChange={(e) => setS({ ...s, defaultPaymentHours: Math.max(1, +e.target.value || 24) })} />
          </Field>
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Email notifications</div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>
          In this prototype no emails are actually sent — customers see every update on their dashboard instead. These settings carry straight into the production build, where they connect to a real email service.
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <Field label="Sender name"><input style={inputStyle} value={s.emailFromName} onChange={set("emailFromName")} /></Field>
          <Field label="From address"><input style={inputStyle} value={s.emailFrom} onChange={set("emailFrom")} /></Field>
          <Field label="Reply-to address"><input style={inputStyle} value={s.emailReplyTo} onChange={set("emailReplyTo")} /></Field>
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, margin: "6px 0 8px" }}>Email delivery</div>
        <Field label="Delivery method" hint="SMTP works with any mail provider (Gmail, Outlook, your web host). An email API service like Resend or SendGrid is simpler to set up and more reliable for automated mail.">
          <select style={{ ...inputStyle, width: "auto" }} value={s.delivery.method} onChange={(e) => setD("method", e.target.value)}>
            <option value="smtp">SMTP server</option>
            <option value="api">Email API service</option>
          </select>
        </Field>
        {s.delivery.method === "smtp" ? (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <Field label="SMTP host"><input style={inputStyle} value={s.delivery.smtpHost} placeholder="smtp.yourprovider.com" onChange={(e) => setD("smtpHost", e.target.value)} /></Field>
            <Field label="Port"><input style={inputStyle} value={s.delivery.smtpPort} placeholder="587" onChange={(e) => setD("smtpPort", e.target.value)} /></Field>
            <Field label="Encryption">
              <select style={inputStyle} value={s.delivery.smtpEncryption} onChange={(e) => setD("smtpEncryption", e.target.value)}>
                <option>TLS (STARTTLS)</option><option>SSL</option><option>None</option>
              </select>
            </Field>
            <Field label="SMTP username"><input style={inputStyle} value={s.delivery.smtpUser} onChange={(e) => setD("smtpUser", e.target.value)} /></Field>
            <Field label="SMTP password"><input style={inputStyle} type="password" value={s.delivery.smtpPass} placeholder="Leave blank in this prototype" onChange={(e) => setD("smtpPass", e.target.value)} /></Field>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <Field label="Provider">
              <select style={inputStyle} value={s.delivery.apiProvider} onChange={(e) => setD("apiProvider", e.target.value)}>
                <option>Resend</option><option>SendGrid</option><option>Postmark</option><option>Mailgun</option><option>Amazon SES</option>
              </select>
            </Field>
            <Field label="API key"><input style={inputStyle} type="password" value={s.delivery.apiKey} placeholder="Leave blank in this prototype" onChange={(e) => setD("apiKey", e.target.value)} /></Field>
          </div>
        )}
        <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>
          Security note: don't enter real passwords or API keys in this prototype — its storage isn't encrypted. In the production system these credentials are stored as protected server configuration, and this page only shows whether delivery is connected.
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, margin: "6px 0 8px" }}>Send an email when…</div>
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          {Object.entries(notifLabels).map(([k, l]) => (
            <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={!!s.notif[k]} onChange={setNotif(k)} /> {l}
            </label>
          ))}
        </div>
        <div style={{ marginTop: 14 }}><Btn onClick={() => actions.saveSettings(s, me.name)}>Save settings</Btn></div>
      </Card>

      <Card>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Staff accounts</div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>
          Super Admins have full access, including this page. Claim Administrators can manage claims, deposits, events, and approve customer sign-ups — but can't change settings or staff.
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
          {staff.map((u) => (
            <div key={u.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", border: `1px solid ${C.line}`, borderRadius: 10 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 700 }}>{u.name} {u.id === me.id && <span style={{ color: C.sub, fontWeight: 400 }}>(you)</span>}</div>
                <div style={{ fontSize: 12, color: C.sub }}>{u.email}{u.status !== "approved" ? ` · ${u.status}` : ""}</div>
              </div>
              {u.id === me.id || u.id === "admin" ? (
                <span style={{ fontSize: 13, fontWeight: 600, color: C.sub }}>{STAFF_ROLES[u.role] || u.role}</span>
              ) : (
                <>
                  <select style={{ ...inputStyle, width: "auto", padding: "6px 8px" }} value={u.role} onChange={(e) => actions.setUserRole(u, e.target.value, me.name)}>
                    <option value="claimadmin">Claim Administrator</option>
                    <option value="superadmin">Super Admin</option>
                  </select>
                  {u.status === "approved"
                    ? <Btn small kind="danger" onClick={() => actions.setUserStatus(u, "suspended", me.name)}>Suspend</Btn>
                    : <Btn small kind="teal" onClick={() => actions.setUserStatus(u, "approved", me.name)}>Reactivate</Btn>}
                </>
              )}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.sub, marginBottom: 8 }}>Add staff member</div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <Field label="Full name"><input style={inputStyle} value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} /></Field>
          <Field label="Email"><input style={inputStyle} value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} /></Field>
          <Field label="Mobile (optional)"><input style={inputStyle} value={nf.mobile} onChange={(e) => setNf({ ...nf, mobile: e.target.value })} /></Field>
          <Field label="PIN"><input style={inputStyle} type="password" value={nf.pin} onChange={(e) => setNf({ ...nf, pin: e.target.value })} /></Field>
          <Field label="Role">
            <select style={inputStyle} value={nf.role} onChange={(e) => setNf({ ...nf, role: e.target.value })}>
              <option value="claimadmin">Claim Administrator</option>
              <option value="superadmin">Super Admin</option>
            </select>
          </Field>
        </div>
        {msg && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{msg}</div>}
        <Btn onClick={createStaff}>Create staff account</Btn>
      </Card>
    </div>
  );
}

/* ---------- Audit tab ---------- */
function AuditTab({ audit }) {
  if (audit.length === 0) return <Empty>Nothing logged yet.</Empty>;
  return (
    <Card style={{ padding: 0 }}>
      {audit.map((a, i) => (
        <div key={i} style={{ display: "flex", gap: 12, padding: "10px 16px", borderBottom: `1px solid ${C.line}`, fontSize: 13, flexWrap: "wrap" }}>
          <span style={{ fontFamily: C.mono, color: C.sub, whiteSpace: "nowrap" }}>{fmtDT(a.ts)}</span>
          <b style={{ whiteSpace: "nowrap" }}>{a.actor}</b>
          <span style={{ color: C.teal, fontWeight: 600, whiteSpace: "nowrap" }}>{a.action}</span>
          <span style={{ color: C.sub }}>{a.detail}</span>
        </div>
      ))}
    </Card>
  );
}
