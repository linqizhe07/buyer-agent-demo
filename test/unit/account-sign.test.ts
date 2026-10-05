import { describe, expect, it } from "vitest";
import { actionHash, agentActionHash, deviceSigningInput, es256Sign, es256Verify, HL, hlRecover, hlSign, hlTypedData, isAgentAction, isOwnerAction, micro, NonceBook, ownerTypedData, shownFields, signAgent, signDevice, signerOf, signOwner, simKey, unmicro, usdOfMicro, ZERO, type AgentAction, type Hex, type OwnerAction } from "../../src/portfolio/account/sign.ts";

const T = Date.parse("2026-10-03T09:30:00.000Z");
const owner = simKey("owner");
const agent = simKey("agent:claude-code");

const send = (over: Partial<Extract<OwnerAction, { type: "sendAsset" }>> = {}): OwnerAction => ({ type: "sendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "500", fromSubAccount: "", route: `0x${"11".repeat(32)}`, maxFee: "1.5", deadline: T + 3_600_000, nonce: T, ...over });
const move = (over: Partial<Extract<AgentAction, { type: "agentSendAsset" }>> = {}): AgentAction => ({ type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "200", fromSubAccount: "", maxFee: "1.5", nonce: T, ...over });

describe("the encoder is Hyperliquid's, byte for byte", () => {
  // hyperliquid-python-sdk tests/signing_test.py: the signatures its test key produces for these two messages on Testnet.
  // Only the signatures and the key's ADDRESS are here: if this encoder hashed one byte differently, they would recover someone else.
  const SDK_ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325";
  const message = { hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 };

  it("recovers the SDK's signer from the SDK's UsdSend signature", async () => {
    const data = hlTypedData("HyperliquidTransaction:UsdSend", "0x66eee", message);
    expect(await hlRecover(data, { r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073", s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27 })).toBe(SDK_ADDRESS);
  });

  it("recovers the SDK's signer from the SDK's Withdraw signature", async () => {
    const data = hlTypedData("HyperliquidTransaction:Withdraw", "0x66eee", message);
    expect(await hlRecover(data, { r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9", s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881", v: 28 })).toBe(SDK_ADDRESS);
  });

  it("one changed field recovers somebody else", async () => {
    const data = hlTypedData("HyperliquidTransaction:UsdSend", "0x66eee", { ...message, amount: "2" });
    expect(await hlRecover(data, { r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073", s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27 })).not.toBe(SDK_ADDRESS);
  });

  it("builds the native messages a Hyperliquid door needs, on the Testnet label", async () => {
    const { typedData, signature } = await hlSign(owner, "HyperliquidTransaction:SendAsset", { destination: owner.address, sourceDex: "", destinationDex: "spot", token: "USDC", amount: "10", fromSubAccount: "", nonce: T });
    expect(typedData.domain.name).toBe("HyperliquidSignTransaction");
    expect(typedData.message.hyperliquidChain).toBe("Testnet");
    expect(await hlRecover(typedData, signature)).toBe(owner.address);
    expect(Object.keys(HL.types)).toContain("HyperliquidTransaction:SendToEvmWithData");
  });
});

describe("the account's own domain", () => {
  it("is not Hyperliquid's: an action signed here is nothing there", async () => {
    const env = await signOwner(owner, send());
    expect(ownerTypedData(send()).domain.name).toBe("AgentAccountSignTransaction");
    // the same fields under Hyperliquid's domain and type name recover a different address
    const asHl = hlTypedData("HyperliquidTransaction:SendAsset", "0x66eee", { hyperliquidChain: "Mainnet", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "500", fromSubAccount: "", nonce: T });
    expect(await hlRecover(asHl, env.signature as never)).not.toBe(owner.address);
  });

  it("an owner signature recovers the owner, and one changed byte does not", async () => {
    const env = await signOwner(owner, send());
    expect(await signerOf(env.action, env.signature)).toBe(owner.address);
    expect(await signerOf(send({ amount: "5000" }), env.signature)).not.toBe(owner.address);
    expect(await signerOf(send({ destination: "0x7a11000000000000000000000000000000000001", destinationDex: "Base" }), env.signature)).not.toBe(owner.address);
    expect(await signerOf(send({ route: `0x${"22".repeat(32)}` }), env.signature)).not.toBe(owner.address);
    expect(await signerOf(send({ maxFee: "99" }), env.signature)).not.toBe(owner.address);
  });

  it("what the surface shows is what is signed, field for field, chain included", () => {
    const names = shownFields(send()).map((f) => f.name);
    expect(names).toEqual(["destination", "sourceDex", "destinationDex", "token", "amount", "fromSubAccount", "route", "maxFee", "deadline", "nonce"]);
    expect(Object.keys(ownerTypedData(send()).message)).toEqual(["accountChain", ...names]);
  });

  it("the two signing classes do not overlap: an agent's signature is never an owner's", async () => {
    const a = move();
    const env = await signAgent(agent, a);
    expect(isAgentAction(a) && !isOwnerAction(a)).toBe(true);
    expect(await signerOf(env.action, env.signature)).toBe(agent.address);
    // the same signature offered for the owner action with the same fields recovers neither key
    const who = await signerOf(send({ amount: "200" }), env.signature);
    expect(who).not.toBe(agent.address);
    expect(who).not.toBe(owner.address);
    // and an approval is its own type: a card answer cannot be replayed as an instruction
    expect(ownerTypedData({ type: "approveCard", card: "card-0001", action: actionHash(a), decision: "approve", nonce: T }).primaryType).toBe("AccountApproval:Card");
  });

  it("the agent's signature commits to every field of what it asks", async () => {
    const env = await signAgent(agent, move());
    expect(await signerOf(move({ amount: "201" }), env.signature)).not.toBe(agent.address);
    expect(await signerOf(move({ nonce: T + 1 }), env.signature)).not.toBe(agent.address);
    expect(agentActionHash(move())).toBe(agentActionHash(move()));
    expect(agentActionHash(move())).not.toBe(agentActionHash(move({ destinationDex: "binance" })));
  });

  it("the action hash is the one id of an instruction", () => {
    expect(actionHash(send())).toMatch(/^0x[0-9a-f]{64}$/);
    expect(actionHash(send())).toBe(actionHash(send()));
    expect(actionHash(send())).not.toBe(actionHash(send({ nonce: T + 1 })));
  });
});

describe("the owner's device key (P-256, the browser holds it)", () => {
  const device = simKey("owner-device");
  const devices = new Map([[device.kid, device.jwk]]);

  it("signs the typed data it shows; the server needs only the public half", async () => {
    const sig = signDevice(device, send());
    expect(await signerOf(send(), sig, devices)).toBe(`device:${device.kid}`);
    expect(deviceSigningInput(send())).toContain('"primaryType":"AccountTransaction:SendAsset"');
    expect(deviceSigningInput(send())).toContain('"amount":"500"');
  });

  it("a changed action, an unknown device and an agent action all fail", async () => {
    const sig = signDevice(device, send());
    expect(await signerOf(send({ amount: "501" }), sig, devices)).toBeNull();
    expect(await signerOf(send(), sig, new Map())).toBeNull();
    expect(await signerOf(move(), sig as never, devices)).toBeNull();
  });

  it("ES256 is raw r‖s and verifies against a JWK", () => {
    const s = es256Sign(device.p256, "header.payload");
    expect(Buffer.from(s, "base64url").length).toBe(64);
    expect(es256Verify(device.jwk, "header.payload", s)).toBe(true);
    expect(es256Verify(device.jwk, "header.payloaD", s)).toBe(false);
    expect(es256Verify(simKey("someone-else").jwk, "header.payload", s)).toBe(false);
  });
});

describe("nonces (Hyperliquid's rule, never forgotten)", () => {
  it("a nonce is used once, and the 100 highest set a floor", () => {
    const book = new NonceBook();
    for (let n = 1000; n < 1100; n++) {
      expect(book.check("s", T + n, T)).toBe("ok");
      book.use("s", T + n);
    }
    expect(book.check("s", T + 1050, T)).toBe("used");
    expect(book.check("s", T + 999, T)).toBe("below-floor");
    expect(book.check("s", T + 1000, T)).toBe("used");
    // out of order is fine as long as it is above the floor and unused
    expect(book.check("s", T + 2000, T)).toBe("ok");
    book.use("s", T + 2000);
    expect(book.check("s", T + 1500, T)).toBe("ok");
    book.use("s", T + 1500);
    // the floor moved up: 1000 and 1001 fell out of the kept set and can never come back
    expect(book.check("s", T + 1000, T)).toBe("below-floor");
    expect(book.check("s", T + 1001, T)).toBe("below-floor");
  });

  it("the window is (now − 2 days, now + 1 day)", () => {
    const book = new NonceBook();
    const DAY = 86_400_000;
    expect(book.check("s", T - 2 * DAY, T)).toBe("too-old");
    expect(book.check("s", T - 2 * DAY + 1, T)).toBe("ok");
    expect(book.check("s", T + DAY, T)).toBe("too-new");
    expect(book.check("s", T + DAY - 1, T)).toBe("ok");
  });

  it("books are per signer, and checking spends nothing", () => {
    const book = new NonceBook();
    expect(book.check("a", T, T)).toBe("ok");
    expect(book.check("a", T, T)).toBe("ok");
    book.use("a", T);
    expect(book.check("a", T, T)).toBe("used");
    expect(book.check("b", T, T)).toBe("ok");
    expect(book.signers()).toEqual(["a"]);
  });
});

describe("amounts", () => {
  it("are added up as integers of one millionth", () => {
    expect(micro("0.1") + micro("0.2")).toBe(micro("0.3"));
    expect(micro("499.99") * 80).toBe(micro("39999.2"));
    expect(micro("5")).toBe(5_000_000);
    expect(micro(0.004)).toBe(4000);
    expect(unmicro(micro("12.340000"))).toBe("12.34");
    expect(unmicro(4_800_000)).toBe("4.8");
    expect(unmicro(-200_000)).toBe("-0.2");
    expect(usdOfMicro(micro("1234.565"))).toBe(1234.57);
  });

  it("anything that is not a plain decimal is not a number", () => {
    for (const bad of ["", "1e3", "-5", "1,000", "abc", "0x10", " "]) expect(Number.isNaN(micro(bad))).toBe(true);
  });
});

describe("keys are derived from labels", () => {
  it("the same label gives the same key, a different label a different one", () => {
    expect(simKey("owner").address).toBe(owner.address);
    expect(simKey("agent:claude-code").address).not.toBe(owner.address);
    expect(owner.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(owner.address).not.toBe(ZERO);
    expect(owner.kid).toHaveLength(16);
    const h: Hex = owner.address;
    expect(h.startsWith("0x")).toBe(true);
  });
});
