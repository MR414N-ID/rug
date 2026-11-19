import dotenv from "dotenv";
dotenv.config();

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PumpSdk } from "@pump-fun/pump-sdk";
import { Telegraf, Markup } from "telegraf";
import bs58 from "bs58";
import fetch from "node-fetch";
import fs from "fs";

// ============ CONFIG ============
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RPC_URL         = process.env.RPC_URL;
const PRIVATE_KEY     = process.env.WALLET_PRIVATE_KEY;
const BUY_AMOUNT_SOL  = parseFloat(process.env.BUY_AMOUNT_SOL || "0.0066"); // ~$1
const SCORE_THRESHOLD = parseInt(process.env.SCORE_THRESHOLD || "70");
const CHAT_ID         = process.env.CHAT_ID || "";
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const POSITIONS_FILE  = "./positions.json";
const CHECK_INTERVAL_MS = 5000;

// ============ RPC HELPERS ============
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
}
async function getTokenSupply(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return r?.value ? parseInt(r.value.amount) : 0;
}
async function getLargestHolders(mint) {
  return (await rpc("getTokenLargestAccounts", [mint]))?.value || [];
}
async function getDevBuy(devWallet) {
  const sigs = await rpc("getSignaturesForAddress", [devWallet, { limit: 20 }]);
  if (!sigs) return 0;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc("getTransaction", [
      s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
    ]);
    try {
      const d = Math.abs(tx.meta.preBalances[0] - tx.meta.postBalances[0]) / 1e9;
      if (d > 0) return d;
    } catch {}
  }
  return 0;
}
async function checkSocial(uri) {
  if (!uri) return { score: 0 };
  try {
    const r = await fetch(uri, { timeout: 3000 });
    const d = await r.json();
    return { score: (d.twitter ? 15 : 0) + (d.telegram ? 15 : 0) + (d.website ? 15 : 0) };
  } catch { return { score: 0 }; }
}

// ============ ANALYZER ============
async function analyze({ mint, devWallet, metadataUri = "", mcap = 0 }) {
  const [holders, supply, devBuy, social] = await Promise.all([
    getLargestHolders(mint), getTokenSupply(mint), getDevBuy(devWallet), checkSocial(metadataUri),
  ]);
  let devHoldPct = 0, top10Pct = 0;
  if (supply > 0 && holders.length) {
    for (const h of holders) {
      const pct = parseInt(h.amount) / supply * 100;
      if (h.address === devWallet) devHoldPct = pct;
    }
    top10Pct = holders.slice(0, 10).reduce((a, h) => a + parseInt(h.amount), 0) / supply * 100;
  }
  const scores = {
    dev_hold: { value: +devHoldPct.toFixed(2), score: devHoldPct < 5 ? 100 : devHoldPct < 10 ? 70 : devHoldPct < 15 ? 40 : 0 },
    top10:    { value: +top10Pct.toFixed(2),  score: top10Pct < 40 ? 100 : top10Pct < 60 ? 70 : top10Pct < 75 ? 40 : 0 },
    dev_buy:  { value: +devBuy.toFixed(3),    score: devBuy >= 0.05 && devBuy <= 0.5 ? 100 : devBuy < 1 ? 70 : devBuy < 2 ? 30 : 0 },
    social:   { value: social,                 score: social.score },
    mcap:     { value: Math.round(mcap),       score: mcap >= 4000 && mcap <= 8000 ? 100 : mcap < 15000 ? 60 : mcap < 30000 ? 20 : 0 },
  };
  const w = { dev_hold: 0.25, top10: 0.25, dev_buy: 0.20, social: 0.15, mcap: 0.15 };
  const total = Object.keys(scores).reduce((a, k) => a + scores[k].score * w[k], 0);
  return {
    mint, score: +total.toFixed(1),
    verdict: total >= 70 ? "SNIPE" : total >= 50 ? "WATCH" : "SKIP",
    breakdown: scores,
  };
}

// ============ TRADER ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const sdk = new PumpSdk(connection);

async function getBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}

async function sendIx(instructions, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet, ...extraSigners]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function buy(mintStr, solAmount) {
  const mint = new PublicKey(mintStr);
  const lamports = Math.floor(solAmount * 1e9);
  
  const state = await sdk.fetchBuyState(mint, wallet.publicKey);
  const ix = await sdk.buyInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint: mint,
    user: wallet.publicKey,
    solAmount: BigInt(lamports),
    amount: BigInt(Math.floor(lamports * 1.1)),
    slippage: 0.1,
  });
  
  return sendIx(ix);
}

async function sellAll(mintStr) {
  const mint = new PublicKey(mintStr);
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const info = await connection.getTokenAccountBalance(ata);
  const raw = BigInt(info.value.amount);
  if (raw === 0n) throw new Error("no token balance");

  const state = await sdk.fetchSellState(mint, wallet.publicKey);
  const ix = await sdk.sellInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint: mint,
    user: wallet.publicKey,
    amount: raw,
    slippage: 0.1,
  });
  
  return sendIx(ix);
}

async function getTokenHoldings() {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  const holdings = [];
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    const amt = info.tokenAmount.uiAmount;
    if (amt > 0) holdings.push({ mint: info.mint, amount: amt, raw: info.tokenAmount.amount });
  }
  return holdings;
}

// ============ LAUNCHER (Fitur Launch Token) ============
async function launchToken({ name, symbol, description, imageUrl, devBuyAmt }) {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const metadataUri = process.env.METADATA_BASE_URI
    ? `${process.env.METADATA_BASE_URI}/${mint.toBase58()}.json` : "https://example.com/meta.json"; // Fallback

  await getOrCreateAssociatedTokenAccount(connection, wallet, mint, wallet.publicKey, true, undefined, undefined, TOKEN_PROGRAM_ID);

  const ix = await sdk.createInstructions({
    mint, mintAuthority: wallet.publicKey,
    name, symbol, uri: metadataUri, creator: wallet.publicKey,
  });
  const sig = await sendIx(ix, [mintKeypair]);

  let devBuySig = null;
  if (devBuyAmt > 0) devBuySig = await buy(mint.toBase58(), devBuyAmt);

  return { mint: mint.toBase58(), signature: sig, devBuySig };
}

// ============ PNL TRACKER + PERSIST ============
let POSITIONS = {};
if (fs.existsSync(POSITIONS_FILE)) {
  try { POSITIONS = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")); } catch {}
}
function savePositions() {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(POSITIONS, null, 2));
}

async function getCurrentPrice(mintStr) {
  try {
    const priceData = await sdk.fetchBuyState(new PublicKey(mintStr), wallet.publicKey);
    return parseFloat(priceData.bondingCurve.virtualSolReserves.toString()) / parseFloat(priceData.bondingCurve.virtualTokenReserves.toString());
  } catch { return 0; }
}

async function getPnl(mint) {
  const pos = POSITIONS[mint];
  if (!pos) return null;
  const current = await getCurrentPrice(mint);
  if (!current || !pos.entryPrice) return null;
  const currentValueSol = current * pos.tokenAmount;
  const pnlSol = currentValueSol - pos.entrySol;
  const pnlPct = (pnlSol / pos.entrySol) * 100;
  return {
    entrySol: pos.entrySol,
    currentSol: +currentValueSol.toFixed(4),
    pnlSol: +pnlSol.toFixed(4),
    pnlPct: +pnlPct.toFixed(1),
    entryPrice: pos.entryPrice,
    currentPrice: current,
    tokenAmount: pos.tokenAmount,
  };
}

// ============ AUTO TP/SL + TRAILING STOP ============
const autoState = {
  enabled: true,
  tp: 40,
  sl: -15,
  trailingEnabled: true,
  trailingPercent: 10,
};

async function autoSellLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
    if (!autoState.enabled) continue;

    const mints = Object.keys(POSITIONS);
    for (const mint of mints) {
      try {
        const pnl = await getPnl(mint);
        if (!pnl) continue;

        const pos = POSITIONS[mint];
        if (!pos.peakPnlPct || pnl.pnlPct > pos.peakPnlPct) {
          pos.peakPnlPct = pnl.pnlPct;
          savePositions();
        }

        let reason = null;
        if (pnl.pnlPct >= autoState.tp) reason = "TP";
        else if (pnl.pnlPct <= autoState.sl) reason = "SL";
        else if (autoState.trailingEnabled && pos.peakPnlPct >= autoState.tp * 0.5 && pnl.pnlPct <= pos.peakPnlPct - autoState.trailingPercent) reason = "TRAILING";

        if (reason) {
          console.log(`[auto-${reason}] ${mint} ${pnl.pnlPct}%`);
          const sig = await sellAll(mint);
          delete POSITIONS[mint];
          savePositions();
          if (CHAT_ID) {
            const emoji = reason === "TP" ? "🟢" : reason === "TRAILING" ? "🟡" : "🔴";
            await bot.telegram.sendMessage(
              CHAT_ID,
              `${emoji} *AUTO ${reason}* ${mint.slice(0, 8)}\nPnL: ${pnl.pnlPct}%\ntx: \`${sig}\``,
              { parse_mode: "Markdown" }
            );
          }
        }
      } catch (e) {
        console.error(`[auto-sell] ${mint} err: ${e.message}`);
      }
    }
  }
}

// ============ BOT UI ============
const bot = new Telegraf(BOT_TOKEN);
const TOKENS = {};
const LAUNCHED = {};
const SESSIONS = {};

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎯 SNIPE", "list_snipe")],
    [Markup.button.callback("🚀 LAUNCH", "launch")],
    [Markup.button.callback("💼 HOLDINGS (PnL + jual)", "holdings")],
    [Markup.button.callback("🔴 DUMP LIST (rugpull)", "dump_list")],
    [Markup.button.callback("⚙️ AUTO TP/SL/TRAILING", "auto_menu")],
    [Markup.button.callback("📊 WALLET", "wallet")],
    [Markup.button.callback("💰 WITHDRAW", "withdraw")],
  ]);
}

async function showMenu(ctx, edit = false) {
  const text = "🤖 *Pump Bot — Full Button*\n\npilih menu:";
  if (edit) return ctx.editMessageText(text, { parse_mode: "Markdown", ...menu() });
  return ctx.reply(text, { parse_mode: "Markdown", ...menu() });
}

bot.start((ctx) => showMenu(ctx));
bot.action("menu", (ctx) => showMenu(ctx, true));

// --- sniper ---
bot.action("list_snipe", (ctx) => {
  const ready = Object.values(TOKENS).filter((t) => t.verdict === "SNIPE");
  if (!ready.length) {
    return ctx.editMessageText("belum ada token siap snipe.", Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ back", "menu")],
    ]));
  }
  const buttons = ready.slice(0, 10).map((t) => [
    Markup.button.callback(`🎯 ${t.mint.slice(0, 6)} | skor ${t.score}`, `snipe_${t.mint}`),
  ]);
  buttons.push([Markup.button.callback("⬅️ back", "menu")]);
  return ctx.editMessageText("pilih token buat dibeli:", Markup.inlineKeyboard(buttons));
});

bot.action(/^snipe_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.editMessageText(`⏳ beli ${BUY_AMOUNT_SOL} SOL di ${mint.slice(0, 8)}...`);
  try {
    const sig = await buy(mint, BUY_AMOUNT_SOL);
    const price = await getCurrentPrice(mint);
    const tokenAmount = price > 0 ? BUY_AMOUNT_SOL / price : 0;
    POSITIONS[mint] = {
      entrySol: BUY_AMOUNT_SOL,
      entryPrice: price,
      tokenAmount,
      peakPnlPct: 0,
      time: Date.now(),
      tx: sig,
    };
    savePositions();
    await ctx.editMessageText(`✅ entry ${mint.slice(0, 8)}\ntx: \`${sig}\`\n\n(auto TP/SL/Trailing aktif)`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💼 HOLDINGS", "holdings")],
        [Markup.button.callback("⬅️ menu", "menu")],
      ]),
    });
  } catch (e) {
    await ctx.editMessageText(`❌ gagal: ${e.message}`, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ menu", "menu")],
    ]));
  }
});

// --- holdings ---
bot.action("holdings", async (ctx) => {
  await ctx.editMessageText("⏳ cek holdings & PnL...");
  try {
    const holdings = await getTokenHoldings();
    if (!holdings.length) {
      return ctx.editMessageText("nggak ada token di wallet.", Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ menu", "menu")],
      ]));
    }
    let totalPnl = 0;
    const lines = [];
    const buttons = [];
    for (const h of holdings) {
      const pnl = await getPnl(h.mint);
      if (pnl) {
        totalPnl += pnl.pnlSol;
        const arrow = pnl.pnlPct >= 0 ? "🟢" : "🔴";
        lines.push(`${arrow} \`${h.mint.slice(0, 6)}\` | ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}% | ${pnl.pnlSol >= 0 ? "+" : ""}${pnl.pnlSol} SOL`);
        buttons.push([
          Markup.button.callback(`${arrow} SELL ${h.mint.slice(0, 6)} (${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%)`, `sellall_${h.mint}`),
          Markup.button.callback(`📊 detail`, `info_${h.mint}`),
        ]);
      } else {
        lines.push(`⚪ \`${h.mint.slice(0, 6)}\` | ${h.amount.toFixed(2)} | no entry data`);
        buttons.push([Markup.button.callback(`🔴 SELL ${h.mint.slice(0, 6)}`, `sellall_${h.mint}`)]);
      }
    }
    const totalArrow = totalPnl >= 0 ? "🟢" : "🔴";
    const header = `💼 *HOLDINGS*\ntotal PnL: ${totalArrow} *${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL*\n\n` + lines.join("\n");
    buttons.push([Markup.button.callback("🔄 REFRESH", "holdings")]);
    buttons.push([Markup.button.callback("⬅️ menu", "menu")]);
    return ctx.editMessageText(header, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    return ctx.editMessageText(`❌ error: ${e.message}`);
  }
});

bot.action(/^sellall_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.editMessageText(`⏳ jual 100% ${mint.slice(0, 8)}...`);
  try {
    const sig = await sellAll(mint);
    delete POSITIONS[mint];
    savePositions();
    await ctx.editMessageText(`✅ sold 100% ${mint.slice(0, 8)}\ntx: \`${sig}\``, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💼 HOLDINGS", "holdings")],
        [Markup.button.callback("⬅️ menu", "menu")],
      ]),
    });
  } catch (e) {
    await ctx.editMessageText(`❌ gagal jual: ${e.message}`, Markup.inlineKeyboard([
      [Markup.button.callback("💼 HOLDINGS", "holdings")],
      [Markup.button.callback("⬅️ menu", "menu")],
    ]));
  }
});

bot.action(/^info_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.editMessageText("⏳ hitung detail...");
  const pnl = await getPnl(mint);
  if (!pnl) {
    return ctx.editMessageText(`\`${mint}\`\n\nno entry data.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔴 SELL 100%", `sellall_${mint}`)],
        [Markup.button.callback("⬅️ holdings", "holdings")],
      ]),
    });
  }
  const arrow = pnl.pnlPct >= 0 ? "🟢" : "🔴";
  const text = `📊 *${mint.slice(0, 8)}...*\n\nentry: ${pnl.entrySol} SOL @ ${pnl.entryPrice.toFixed(8)}\ncurrent: ${pnl.currentSol} SOL @ ${pnl.currentPrice.toFixed(8)}\ntoken: ${pnl.tokenAmount.toFixed(2)}\n\n${arrow} *PnL: ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%* (${pnl.pnlSol >= 0 ? "+" : ""}${pnl.pnlSol} SOL)`;
  return ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔴 SELL 100%", `sellall_${mint}`)],
      [Markup.button.callback("⬅️ holdings", "holdings")],
    ]),
  });
});

// --- auto menu ---
bot.action("auto_menu", (ctx) => {
  const s = autoState;
  const status = s.enabled ? "🟢 ON" : "🔴 OFF";
  const trail = s.trailingEnabled ? `🟢 ON (${s.trailingPercent}%)` : "🔴 OFF";
  return ctx.editMessageText(
    `⚙️ *AUTO TP/SL/TRAILING*\n\nstatus: ${status}\nTP: +${s.tp}%\nSL: ${s.sl}%\ntrailing: ${trail}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`auto-sell: ${s.enabled ? "OFF" : "ON"}`, "auto_toggle")],
        [Markup.button.callback(`trailing: ${s.trailingEnabled ? "OFF" : "ON"}`, "trail_toggle")],
        [Markup.button.callback("set TP", "auto_set_tp"), Markup.button.callback("set SL", "auto_set_sl")],
        [Markup.button.callback("set trailing %", "trail_set")],
        [Markup.button.callback("⬅️ menu", "menu")],
      ]),
    }
  );
});

bot.action("auto_toggle", async (ctx) => {
  autoState.enabled = !autoState.enabled;
  await ctx.answerCbQuery(`auto-sell ${autoState.enabled ? "ON" : "OFF"}`);
  return ctx.editMessageText(`auto-sell sekarang: ${autoState.enabled ? "🟢 ON" : "🔴 OFF"}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ auto menu", "auto_menu")]]));
});

bot.action("trail_toggle", async (ctx) => {
  autoState.trailingEnabled = !autoState.trailingEnabled;
  await ctx.answerCbQuery(`trailing ${autoState.trailingEnabled ? "ON" : "OFF"}`);
  return ctx.editMessageText(`trailing stop: ${autoState.trailingEnabled ? "🟢 ON" : "🔴 OFF"}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ auto menu", "auto_menu")]]));
});

bot.action("auto_set_tp", (ctx) => {
  SESSIONS[ctx.chat.id] = { step: "set_tp" };
  return ctx.editMessageText("kirim angka TP (contoh: 40 buat +40%):", Markup.inlineKeyboard([[Markup.button.callback("❌ cancel", "auto_menu")]]));
});
bot.action("auto_set_sl", (ctx) => {
  SESSIONS[ctx.chat.id] = { step: "set_sl" };
  return ctx.editMessageText("kirim angka SL (contoh: -15 buat -15%):", Markup.inlineKeyboard([[Markup.button.callback("❌ cancel", "auto_menu")]]));
});
bot.action("trail_set", (ctx) => {
  SESSIONS[ctx.chat.id] = { step: "set_trail" };
  return ctx.editMessageText("kirim trailing % (contoh: 10 buat jual kalau turun 10% dari peak):", Markup.inlineKeyboard([[Markup.button.callback("❌ cancel", "auto_menu")]]));
});

// --- launch flow ---
bot.action("launch", (ctx) => {
  SESSIONS[ctx.chat.id] = { step: "name", data: {} };
  return ctx.editMessageText("🚀 *LAUNCH TOKEN*\n\nmasukkan nama token:", {
    parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ cancel", "menu")]]),
  });
});

// --- text handler (semua input) ---
bot.on("text", async (ctx, next) => {
  const s = SESSIONS[ctx.chat.id];
  if (!s) return next();
  const text = ctx.message.text.trim();

  if (s.step === "set_tp") { autoState.tp = parseFloat(text); delete SESSIONS[ctx.chat.id]; return ctx.reply(`TP diset ke +${autoState.tp}%`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ auto menu", "auto_menu")]])); }
  if (s.step === "set_sl") { autoState.sl = parseFloat(text); delete SESSIONS[ctx.chat.id]; return ctx.reply(`SL diset ke ${autoState.sl}%`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ auto menu", "auto_menu")]])); }
  if (s.step === "set_trail") { autoState.trailingPercent = parseFloat(text); delete SESSIONS[ctx.chat.id]; return ctx.reply(`trailing diset ke ${autoState.trailingPercent}%`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ auto menu", "auto_menu")]])); }

  if (s.step === "name") { s.data.name = text; s.step = "symbol"; return ctx.reply("simbol token:"); }
  if (s.step === "symbol") { s.data.symbol = text.toUpperCase(); s.step = "description"; return ctx.reply("deskripsi:"); }
  if (s.step === "description") { s.data.description = text; s.step = "image"; return ctx.reply("URL image (atau '-' skip):"); }
  if (s.step === "image") { s.data.imageUrl = text === "-" ? "" : text; s.step = "devbuy"; return ctx.reply("dev buy berapa SOL? (contoh 0.05, atau '-' skip):"); }
  
  if (s.step === "devbuy") {
    const devBuyAmt = text === "-" ? 0 : parseFloat(text);
    delete SESSIONS[ctx.chat.id];
    await ctx.reply("⏳ launch...");
    try {
      const res = await launchToken({ ...s.data, devBuyAmt });
      LAUNCHED[res.mint] = { ...res, ...s.data };
      await ctx.reply(
        `✅ *LAUNCHED*\nmint: \`${res.mint}\`\nsymbol: ${s.data.symbol}\ntx: \`${res.signature}\`` + (res.devBuySig ? `\ndev buy tx: \`${res.devBuySig}\`` : ""),
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔴 DUMP TOKEN INI", `dump_${res.mint}`)], [Markup.button.callback("⬅️ menu", "menu")]]) }
      );
    } catch (e) {
      await ctx.reply(`❌ launch gagal: ${e.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
    }
  }
  
  if (s.step === "withdraw_addr") { s.data.dest = text; s.step = "withdraw_amt"; return ctx.reply("jumlah SOL yang mau ditarik:"); }
  if (s.step === "withdraw_amt") {
    const amt = parseFloat(text);
    delete SESSIONS[ctx.chat.id];
    try {
      const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(s.data.dest), lamports: Math.floor(amt * LAMPORTS_PER_SOL) });
      const sig = await sendIx([ix]);
      return ctx.reply(`✅ withdraw ${amt} SOL\ntx: \`${sig}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]) });
    } catch (e) {
      return ctx.reply(`❌ withdraw gagal: ${e.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
    }
  }
});

// --- dump list ---
bot.action("dump_list", (ctx) => {
  const launched = Object.entries(LAUNCHED);
  if (!launched.length) return ctx.editMessageText("belum ada token yang lo launch.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
  const buttons = launched.map(([mint, info]) => [Markup.button.callback(`🔴 DUMP ${info.symbol} (${mint.slice(0, 6)})`, `dump_${mint}`)]);
  buttons.push([Markup.button.callback("⬅️ menu", "menu")]);
  return ctx.editMessageText("pilih token buat dump 100%:", Markup.inlineKeyboard(buttons));
});

bot.action(/^dump_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.editMessageText(`⏳ dump 100% ${mint.slice(0, 8)}...`);
  try {
    const sig = await sellAll(mint);
    delete POSITIONS[mint];
    savePositions();
    await ctx.editMessageText(`🔴 *DUMPED* ${mint.slice(0, 8)}\ntx: \`${sig}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔴 DUMP LIST", "dump_list")], [Markup.button.callback("⬅️ menu", "menu")]]) });
  } catch (e) {
    await ctx.editMessageText(`❌ gagal dump: ${e.message}`, Markup.inlineKeyboard([[Markup.button.callback("🔴 DUMP LIST", "dump_list")], [Markup.button.callback("⬅️ menu", "menu")]]));
  }
});

// --- wallet / withdraw ---
bot.action("wallet", async (ctx) => {
  const bal = await getBalance();
  await ctx.editMessageText(`📊 *WALLET*\nSOL: *${bal.toFixed(4)}*\naddr: \`${wallet.publicKey.toBase58()}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("💰 WITHDRAW", "withdraw")], [Markup.button.callback("⬅️ menu", "menu")]]) });
});

bot.action("withdraw", (ctx) => {
  SESSIONS[ctx.chat.id] = { step: "withdraw_addr", data: {} };
  return ctx.editMessageText("💰 *WITHDRAW*\n\nkirim alamat tujuan:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ cancel", "menu")]]) });
});

// --- auto monitor sniper (VERSI FIX: maxSupportedTransactionVersion 1) ---
connection.onLogs(
  new PublicKey(PUMP_PROGRAM_ID),
  async ({ logs, signature }) => {
    try {
      if (!logs.some((l) => l.includes("Instruction: Create"))) return;
      
      const tx = await connection.getTransaction(signature, { 
        maxSupportedTransactionVersion: 1, // <--- UDAH DIGANTI JADI 1
        commitment: "confirmed" 
      });
      
      if (!tx || !tx.meta || !tx.transaction || !tx.transaction.message || !tx.transaction.message.accountKeys) return;
      
      const mint = (tx.meta.postTokenBalances || [])[0]?.mint;
      if (!mint) return;
      
      const dev = tx.transaction.message.accountKeys[0]?.toString();
      if (!dev) return;

      const res = await analyze({ mint, devWallet: dev });
      TOKENS[mint] = res;
      
      if (res.score >= SCORE_THRESHOLD && CHAT_ID) {
        await bot.telegram.sendMessage(
          CHAT_ID, 
          `🎯 *NEW SNIPE CANDIDATE*\n\`${mint}\`\nskor: ${res.score}`, 
          { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🎯 SNIPE", "list_snipe")]]) }
        );
      }
    } catch (e) {
      console.error("Monitor skip error:", e.message);
    }
  },
  "confirmed"
);

autoSellLoop();
bot.launch();
console.log("🚀 bot running — sniper + launcher + rugpull + PnL + TP/SL + trailing");
