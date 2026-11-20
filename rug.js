import dotenv from "dotenv";
dotenv.config();

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PumpSdk } from "@pump-fun/pump-sdk";
import { Telegraf, Markup } from "telegraf";
import bs58 from "bs58";
import fetch from "node-fetch";
import fs from "fs";

// ============ CONFIG — AUTO-TUNED BUAT MODAL KECIL ============
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RPC_URL         = process.env.RPC_URL;
const PRIVATE_KEY     = process.env.WALLET_PRIVATE_KEY;
const MAIN_WALLET     = process.env.MAIN_WALLET_ADDRESS || "";
const CHAT_ID         = process.env.CHAT_ID || "";
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const POSITIONS_FILE  = "./positions.json";

// AUTO-TUNE: kalau saldo kecil, maxCoins otomatis turun biar posisi lebih gede
const SCORE_THRESHOLD   = parseInt(process.env.SCORE_THRESHOLD || "82");   // naik dari 70 → selektif
const MAX_COINS_CFG     = parseInt(process.env.MAX_COINS || "2");          // turun dari 5 → 2
const GAS_RESERVE       = parseFloat(process.env.GAS_RESERVE || "0.008");  // naik dari 0.005
const SLIPPAGE_BUY      = parseFloat(process.env.SLIPPAGE_BUY || "0.06");  // turun dari 0.15
const SLIPPAGE_SELL     = parseFloat(process.env.SLIPPAGE_SELL || "0.10"); // turun dari 0.20
const PRIORITY_FEE      = parseInt(process.env.PRIORITY_FEE || "50000");   // microLamports
const MIN_LIQ_SOL       = parseFloat(process.env.MIN_LIQ_SOL || "25");     // skip bonding curve < 25 SOL

const WELCOME_IMG = "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?q=80&w=1000&auto=format&fit=crop";

// ============ RPC HELPERS ============
let isRpcBusy = false;
async function rpc(method, params) {
  if (isRpcBusy) await new Promise(r => setTimeout(r, 1500));
  isRpcBusy = true;
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error && json.error.code === 429) await new Promise(r => setTimeout(r, 3000));
    return json.result;
  } finally {
    setTimeout(() => { isRpcBusy = false; }, 800);
  }
}

async function getTokenSupply(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return r?.value ? parseInt(r.value.amount) : 0;
}
async function getLargestHolders(mint) {
  return (await rpc("getTokenLargestAccounts", [mint]))?.value || [];
}

// ============ ANALYZER — TAMBAH FILTER LIKUIDITAS ============
async function analyze({ mint, devWallet }) {
  try {
    const holders = await getLargestHolders(mint);
    const supply = await getTokenSupply(mint);
    let devHoldPct = 0, top10Pct = 0;

    if (supply > 0 && holders.length) {
      for (const h of holders) {
        const pct = parseInt(h.amount) / supply * 100;
        if (h.address === devWallet) devHoldPct = pct;
      }
      top10Pct = holders.slice(0, 10).reduce((a, h) => a + parseInt(h.amount), 0) / supply * 100;
    }

    // cek likuiditas bonding curve — skip kalau terlalu tipis
    let liqSol = 0;
    try {
      const pData = await sdk.fetchBuyState(new PublicKey(mint), wallet.publicKey);
      liqSol = parseFloat(pData.bondingCurve.virtualSolReserves.toString()) / 1e9;
    } catch {}
    if (liqSol < MIN_LIQ_SOL) return { score: 0, reason: `liq ${liqSol.toFixed(1)} SOL < ${MIN_LIQ_SOL}` };

    let volumeScore = 0;
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const dexData = await dexRes.json();
      if (dexData.pairs && dexData.pairs.length > 0) {
        const vol5m = parseFloat(dexData.pairs[0].volume?.m5 || "0");
        if (vol5m > 1000) volumeScore = 100;
        else if (vol5m > 100) volumeScore = 50;
      }
    } catch {}

    const scores = {
      dev_hold: devHoldPct < 3 ? 100 : devHoldPct < 7 ? 70 : 0,
      top10: top10Pct < 35 ? 100 : top10Pct < 55 ? 70 : 0,
      volume: volumeScore,
    };
    const total = (scores.dev_hold * 0.4) + (scores.top10 * 0.3) + (scores.volume * 0.3);
    return { score: +total.toFixed(1), reason: `dev ${devHoldPct.toFixed(1)}% top10 ${top10Pct.toFixed(1)}% liq ${liqSol.toFixed(0)}` };
  } catch (e) { return { score: 0, reason: e.message }; }
}

// ============ TRADER ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const sdk = new PumpSdk(connection);

async function getRawBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}
async function getSafeBalance() {
  const raw = await getRawBalance();
  const usable = raw - GAS_RESERVE;
  return usable > 0 ? usable : 0;
}

// FIX: priority fee + retry + slippage bener
async function sendIx(instructions, extraSigners = []) {
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE });
  const allIx = [priorityIx, ...instructions];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: allIx,
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([wallet, ...extraSigners]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
      return sig;
    } catch (e) {
      lastErr = e;
      console.error(`sendIx attempt ${attempt + 1} failed:`, e.message);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// FIX: hitung amount bener berdasarkan harga bonding curve
async function buy(mintStr, solAmount) {
  const mint = new PublicKey(mintStr);
  const lamports = Math.floor(solAmount * 1e9);
  const state = await sdk.fetchBuyState(mint, wallet.publicKey);
  const price = parseFloat(state.bondingCurve.virtualSolReserves.toString()) /
                parseFloat(state.bondingCurve.virtualTokenReserves.toString());
  const expectedTokens = (solAmount / price);
  const minTokens = Math.floor(expectedTokens * (1 - SLIPPAGE_BUY));
  const ix = await sdk.buyInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: wallet.publicKey,
    solAmount: BigInt(lamports), amount: BigInt(minTokens), slippage: SLIPPAGE_BUY,
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
    bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: wallet.publicKey,
    amount: raw, slippage: SLIPPAGE_SELL,
  });
  return sendIx(ix);
}

async function getTokenHoldings() {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  const holdings = [];
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.tokenAmount.uiAmount > 0) holdings.push({ mint: info.mint, amount: info.tokenAmount.uiAmount });
  }
  return holdings;
}

// ============ STATE ============
let POSITIONS = {};
if (fs.existsSync(POSITIONS_FILE)) { try { POSITIONS = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")); } catch {} }
function savePositions() { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(POSITIONS, null, 2)); }

const hardMode = { active: false, initialBalance: 0, maxLossLimit: 0.5 };
function currentMaxCoins() {
  // auto-tune: saldo < 0.04 SOL → 2 koin, saldo lebih → naik bertahap max 4
  const bal = hardMode.initialBalance || 0;
  if (bal < 0.04) return 2;
  if (bal < 0.08) return 3;
  return Math.min(MAX_COINS_CFG, 4);
}

async function getCurrentPrice(mintStr) {
  try {
    const pData = await sdk.fetchBuyState(new PublicKey(mintStr), wallet.publicKey);
    return parseFloat(pData.bondingCurve.virtualSolReserves.toString()) /
           parseFloat(pData.bondingCurve.virtualTokenReserves.toString());
  } catch { return 0; }
}

// ============ AUTO TP/SL ============
async function hardModeLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 15000));
    if (!hardMode.active) continue;
    for (const mint of Object.keys(POSITIONS)) {
      try {
        const pnl = await getPnl(mint);
        if (!pnl) continue;
        const pos = POSITIONS[mint];
        if (!pos.peakPnlPct || pnl.pnlPct > pos.peakPnlPct) { pos.peakPnlPct = pnl.pnlPct; savePositions(); }
        let reason = null, trail = 0;
        if (pos.peakPnlPct >= 100) trail = 25;
        else if (pos.peakPnlPct >= 80) trail = 20;
        else if (pos.peakPnlPct >= 60) trail = 15;
        else if (pos.peakPnlPct >= 40) trail = 10;
        else if (pos.peakPnlPct >= 20) trail = 5;
        if (pnl.pnlPct <= -15) reason = "CUT LOSS";                         // lebih ketat: -15 bukan -20
        else if (trail > 0 && pnl.pnlPct <= (pos.peakPnlPct - trail)) reason = "TRAILING";
        if (reason) {
          const sig = await sellAll(mint);
          delete POSITIONS[mint]; savePositions();
          if (CHAT_ID) {
            const emoji = pnl.pnlSol >= 0 ? "🟢" : "🔴";
            await bot.telegram.sendMessage(CHAT_ID,
              `${emoji} *HARD ${reason}* ${mint.slice(0, 8)}\nPnL: ${pnl.pnlPct}% (${pnl.pnlSol.toFixed(4)} SOL)\ntx: \`${sig}\``,
              { parse_mode: "Markdown" });
          }
        }
      } catch (e) { console.error("loop error", mint, e.message); }
    }
  }
}

async function getPnl(mint) {
  const pos = POSITIONS[mint]; if (!pos) return null;
  const current = await getCurrentPrice(mint); if (!current || !pos.entryPrice) return null;
  const currentValueSol = current * pos.tokenAmount;
  const pnlSol = currentValueSol - pos.entrySol;
  return { pnlSol: +pnlSol.toFixed(4), pnlPct: +((pnlSol / pos.entrySol) * 100).toFixed(1) };
}

// ============ AUTO MONITOR ============
connection.onLogs(new PublicKey(PUMP_PROGRAM_ID), async ({ logs, signature }) => {
  try {
    if (!hardMode.active) return;
    if (!logs.some(l => l.includes("Instruction: Create"))) return;
    const holdings = await getTokenHoldings();
    const maxC = currentMaxCoins();
    if (holdings.length >= maxC) return;
    const safeBalance = await getSafeBalance();
    if (safeBalance <= (hardMode.initialBalance * hardMode.maxLossLimit)) {
      hardMode.active = false;
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `🚨 *CIRCUIT BREAKER* 🚨\nSaldo turun 50%! Bot mati.`, { parse_mode: "Markdown" });
      return;
    }
    const buyAmount = safeBalance / maxC;
    if (buyAmount < 0.003) return;
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
    const mint = (tx?.meta?.postTokenBalances || [])[0]?.mint;
    if (!mint) return;
    const res = await analyze({ mint, devWallet: tx.transaction.message.accountKeys[0]?.toString() });
    if (res.score >= SCORE_THRESHOLD) {
      const sig = await buy(mint, buyAmount);
      const price = await getCurrentPrice(mint);
      POSITIONS[mint] = { entrySol: buyAmount, entryPrice: price, tokenAmount: buyAmount / price, peakPnlPct: 0, tx: sig };
      savePositions();
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID,
        `🔥 *BUY* \`${mint.slice(0, 8)}\` | ${buyAmount.toFixed(4)} SOL | skor ${res.score} (${res.reason})\ntx: \`${sig}\``,
        { parse_mode: "Markdown" });
    }
  } catch (e) { console.error("onLogs error:", e.message); }
}, "confirmed");

// ============ BOT UI ============
const bot = new Telegraf(BOT_TOKEN);
function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 HARD MODE MENU 🔥", "hard_menu")],
    [Markup.button.callback("💼 HOLDINGS (PnL)", "holdings")],
    [Markup.button.callback("📊 WALLET", "wallet")],
  ]);
}
const WELCOME_TEXT =
  "📈 *LANOX TRADING MEME COIN* 📈\n\n" +
  "🤖 *Status Bot:* Siap Beraksi\n" +
  "💰 *Mode:* Hard Mode Compounding\n" +
  "⚡ *Jaringan:* Solana (Pump.fun)\n\n" +
  "Silakan pilih menu di bawah untuk mulai mencetak cuan:";

async function safeEdit(ctx, text, keyboard) {
  const opts = { parse_mode: "Markdown", ...keyboard };
  try { await ctx.editMessageCaption(text, opts); return; } catch {}
  try { await ctx.editMessageText(text, opts); return; } catch {}
  try { await ctx.reply(text, opts); } catch (e) { console.error("safeEdit:", e.message); }
}

bot.start(ctx => ctx.replyWithPhoto(WELCOME_IMG, { caption: WELCOME_TEXT, parse_mode: "Markdown", ...menu() })
  .catch(() => ctx.reply(WELCOME_TEXT, { parse_mode: "Markdown", ...menu() }).catch(() => {})));
bot.action("menu", ctx => safeEdit(ctx, WELCOME_TEXT, menu()));

bot.action("hard_menu", async ctx => {
  const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
  const text = `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${currentMaxCoins()}\nCircuit Breaker: -50%\nScore Min: ${SCORE_THRESHOLD}\nSlippage: ${(SLIPPAGE_BUY*100).toFixed(0)}%/${(SLIPPAGE_SELL*100).toFixed(0)}%`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
    [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
    [Markup.button.callback("⬅️ menu", "menu")],
  ]);
  await safeEdit(ctx, text, kb);
});

bot.action("hard_toggle", async ctx => {
  try {
    if (!hardMode.active) {
      const bal = await getSafeBalance();
      if (bal < 0.01) return ctx.answerCbQuery("❌ Saldo aman < 0.01 SOL!", { show_alert: true });
      hardMode.initialBalance = bal;
      hardMode.active = true;
      await ctx.answerCbQuery("Hard Mode ON!");
    } else {
      hardMode.active = false;
      if (MAIN_WALLET) {
        try {
          await ctx.reply("⏳ Withdraw ke main wallet...");
          const raw = await getRawBalance();
          const sendAmt = raw - 0.00001;
          if (sendAmt > 0) {
            const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(MAIN_WALLET), lamports: Math.floor(sendAmt * LAMPORTS_PER_SOL) });
            const sig = await sendIx([ix]);
            await ctx.reply(`✅ *WITHDRAW OK*\n${sendAmt.toFixed(4)} SOL → main\ntx: \`${sig}\``, { parse_mode: "Markdown" });
          }
        } catch (e) { await ctx.reply(`❌ Withdraw gagal: ${e.message}`); }
      }
    }
    const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
    const text = `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${currentMaxCoins()}\nCircuit Breaker: -50%\nScore Min: ${SCORE_THRESHOLD}\nSlippage: ${(SLIPPAGE_BUY*100).toFixed(0)}%/${(SLIPPAGE_SELL*100).toFixed(0)}%`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
      [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
      [Markup.button.callback("⬅️ menu", "menu")],
    ]);
    await safeEdit(ctx, text, kb);
  } catch (e) { console.error("toggle:", e.message); try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action("hard_sellall", async ctx => {
  try {
    await ctx.answerCbQuery("Jual semua...");
    const holdings = await getTokenHoldings();
    let ok = 0, fail = 0;
    for (const h of holdings) {
      try { await sellAll(h.mint); delete POSITIONS[h.mint]; ok++; } catch { fail++; }
    }
    savePositions();
    await ctx.reply(`✅ SELL ALL: ${ok} sukses, ${fail} gagal`);
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action("holdings", async ctx => {
  try {
    const holdings = await getTokenHoldings();
    let text = "💼 *HOLDINGS*\n\n";
    const btns = [];
    if (!holdings.length) text += "_Tidak ada token._";
    for (const h of holdings) {
      const pnl = await getPnl(h.mint);
      text += pnl ? `- \`${h.mint.slice(0,6)}\` : ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%\n` : `- \`${h.mint.slice(0,6)}\`\n`;
      btns.push([Markup.button.callback(`🔴 SELL ${h.mint.slice(0,6)}`, `sellall_${h.mint}`)]);
    }
    btns.push([Markup.button.callback("⬅️ menu", "menu")]);
    await safeEdit(ctx, text, Markup.inlineKeyboard(btns));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action(/^sellall_(.+)$/, async ctx => {
  const mint = ctx.match[1];
  try { await ctx.answerCbQuery("Jual..."); await sellAll(mint); delete POSITIONS[mint]; savePositions(); await ctx.reply(`✅ sold \`${mint.slice(0,8)}\``, { parse_mode: "Markdown" }); }
  catch (e) { await ctx.reply(`❌ gagal: ${e.message}`); }
});

bot.action("wallet", async ctx => {
  try {
    const bal = await getRawBalance();
    const text = `📊 *WALLET BOT*\nSOL: *${bal.toFixed(4)}*\naddr: \`${wallet.publicKey.toBase58()}\``;
    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

// ============ GUARDS ============
process.on("unhandledRejection", r => console.error("⚠️ Unhandled:", r?.message || r));
process.on("uncaughtException", e => console.error("⚠️ Uncaught:", e?.message || e));

hardModeLoop().catch(e => console.error("loop crashed:", e.message));
bot.catch((err, ctx) => console.error(`Telegraf ${ctx?.updateType}:`, err.message));
bot.launch();
console.log("📈 LANOX BOT RUNNING — AUTO-TUNED 📈");
