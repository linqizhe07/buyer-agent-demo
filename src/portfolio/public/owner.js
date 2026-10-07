/* The owner's device key.
   A P-256 key this browser makes once and cannot export; the server only ever gets its public half. An owner action is prepared by the
   server (a movement gets its route, its fee and its arrival there), shown as typed fields, and signed here over exactly those fields:
   the signing input is built in this file from what is shown, not taken from the server. */
const Owner = (() => {
  let role = "unknown";
  let kid = "";

  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])])) : v);
  const canonical = (v) => JSON.stringify(sortKeys(v));

  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open("buyer-agent-owner", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction("keys", mode).objectStore("keys"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };

  async function key() {
    let k = await tx("readonly", (s) => s.get("device"));
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      await tx("readwrite", (s) => s.put(k, "device"));
    }
    return k;
  }

  /* a POST as { status, body }; one that never reaches the account (the service restarting, the network gone) is answered as a refusal in
     the same shape, so every sheet shows it the way it shows a refusal, instead of staying at "Asking…" */
  async function post(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch {
      return { status: 0, body: { ok: false, error: "The account did not answer. Try again." } };
    }
  }

  /** offer this browser's public key; the first device to do so becomes the owner's device — on a server that moves real money, only with
      the code that server printed in its terminal (`code`) */
  async function ready(code) {
    try {
      const k = await key();
      const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
      const r = await post("/api/account/pair", { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, label: "this browser", ...(code ? { code } : {}) });
      if (r.status !== 200) return { role, refusal: why(r) };
      role = r.body.role;
      kid = r.body.kid || "";
    } catch {
      role = "none";
    }
    return { role };
  }

  async function sign(prepared) {
    const message = { accountChain: prepared.accountChain };
    for (const f of prepared.shown) message[f.name] = f.value;
    const input = canonical({ domain: prepared.domain, primaryType: prepared.primaryType, message });
    const k = await key();
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new TextEncoder().encode(input));
    return { kid, es256: b64u(sig) };
  }

  const prepare = (draft) => post("/api/account/prepare", { draft });
  const submit = async (prepared) => post("/api/exchange", { action: prepared.action, nonce: prepared.action.nonce, signature: await sign(prepared) });
  /** prepare, sign, send: what one button on the page does. Only a prepared action — fields to sign — is signed; a refusal in any shape is
      handed back as it came */
  async function act(draft) {
    const p = await prepare(draft);
    return p.status === 200 && p.body && p.body.ok !== false && Array.isArray(p.body.shown) ? submit(p.body) : p;
  }
  /** a refusal as one sentence */
  const why = (r) => (r.body && r.body.refusal && r.body.refusal.message) || (r.body && r.body.error) || (r.body && r.body.result && r.body.result.message) || "";

  return { ready, prepare, submit, act, why, get role() { return role; }, get kid() { return kid; } };
})();
